#include "tree_sitter/parser.h"
#include "tree_sitter/array.h"
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>

/*
  WASM Compatibility Guards

  When compiling for WASM (detected by __EMSCRIPTEN__ or WASM_BUILD),
  disable all debug logging to avoid using unavailable stdio functions.
*/

/* First, check for WASM target and set a flag */
#if defined(__EMSCRIPTEN__) || defined(WASM_BUILD) || defined(__wasm__)
  #define IS_WASM 1
#else
  #define IS_WASM 0
#endif

/* Now conditionally include stdio and define DEBUG_LOG */
#if IS_WASM
  /* WASM builds: Debug logging completely disabled */
  #define DEBUG_LOG(...)
#else
  /* Native builds: Enable debug logging to stderr */
  #include <stdio.h>
  #define DEBUG_LOG(...) fprintf(stderr, __VA_ARGS__)
#endif

enum TokenType {
  NEWLINE,              // end of line (must match grammar externals[0])
  INDENT,               // increased indentation level (must match grammar externals[1])
  DEDENT,               // decreased indentation level (must match grammar externals[2])
};

// Character classification using tree-sitter's set_contains
static const TSCharacterRange NEWLINE_CHARS[] = {
  {'\n', '\n'},
  {'\r', '\r'},
};

static const TSCharacterRange HSPACE_CHARS[] = {
  {'\t', '\t'},
  {' ',  ' '},
};

static inline bool is_newline(int32_t c) {
  return set_contains(NEWLINE_CHARS, 2, c);
}

static inline bool is_hspace(int32_t c) {
  return set_contains(HSPACE_CHARS, 2, c);
}

typedef struct {
  Array(uint16_t) indents;        // dynamic stack of indentation levels (column positions)
  bool at_line_start;             // are we at the start of a logical line?
  bool seen_non_whitespace;       // have we seen non-whitespace on this line?
  uint16_t current_indent;        // indentation of current line
  uint16_t pending_newlines;      // blank lines to emit after dedents
} Scanner;

void *tree_sitter_kippy_external_scanner_create(void) {
  Scanner *s = (Scanner *)calloc(1, sizeof(Scanner));
  if (s) {
    array_init(&s->indents);
    // Base indentation is 0
    uint16_t base = 0;
    array_push(&s->indents, base);
    s->at_line_start = true;
    s->seen_non_whitespace = false;
    s->current_indent = 0;
    s->pending_newlines = 0;

    DEBUG_LOG("[SCANNER_STATE] >>> CREATE\n");
    DEBUG_LOG("[SCANNER_STATE]     at_line_start=%d, seen_non_ws=%d, current_indent=%d, pending_newlines=%d\n",
      s->at_line_start, s->seen_non_whitespace, s->current_indent, s->pending_newlines);
    DEBUG_LOG("[SCANNER_STATE]     stack_size=%u, stack=[", s->indents.size);
    for (uint32_t i = 0; i < s->indents.size; i++) {
      DEBUG_LOG("%d%s", s->indents.contents[i], (i < s->indents.size-1) ? ", " : "");
    }
    DEBUG_LOG("]\n");
  }
  return s;
}

void tree_sitter_kippy_external_scanner_destroy(void *payload) {
  if (payload) {
    Scanner *s = (Scanner *)payload;
    array_delete(&s->indents);
    free(s);
  }
}

unsigned tree_sitter_kippy_external_scanner_serialize(void *payload, char *buffer) {
  Scanner *s = (Scanner *)payload;
  unsigned pos = 0;

  DEBUG_LOG("[SCANNER_STATE] >>> SERIALIZE (before packing)\n");
  DEBUG_LOG("[SCANNER_STATE]     at_line_start=%d, seen_non_ws=%d, current_indent=%d, pending_newlines=%d\n",
    s->at_line_start, s->seen_non_whitespace, s->current_indent, s->pending_newlines);
  DEBUG_LOG("[SCANNER_STATE]     stack_size=%u, stack=[", s->indents.size);
  for (uint32_t i = 0; i < s->indents.size; i++) {
    DEBUG_LOG("%d%s", s->indents.contents[i], (i < s->indents.size-1) ? ", " : "");
  }
  DEBUG_LOG("]\n");

  // Serialize flags (1 byte): bit 0 = at_line_start, bit 1 = seen_non_whitespace
  uint8_t flags = 0;
  if (s->at_line_start) flags |= 0x01;
  if (s->seen_non_whitespace) flags |= 0x02;
  buffer[pos++] = (char)flags;

  // Serialize pending_newlines (2 bytes, little-endian)
  buffer[pos++] = (char)(s->pending_newlines & 0xFF);
  buffer[pos++] = (char)((s->pending_newlines >> 8) & 0xFF);

  DEBUG_LOG("[SCANNER_STATE]     packed flags: 0x%02x (at_line_start=%d, seen_non_ws=%d)\n",
    flags, (flags & 0x01) != 0, (flags & 0x02) != 0);
  DEBUG_LOG("[SCANNER_STATE]     packed pending_newlines: %d (bytes: 0x%02x 0x%02x)\n",
    s->pending_newlines, (s->pending_newlines & 0xFF), ((s->pending_newlines >> 8) & 0xFF));

  // Calculate maximum number of entries that fit in buffer (after flags + pending_newlines)
  uint32_t max_entries = (TREE_SITTER_SERIALIZATION_BUFFER_SIZE - 1 - 2 - 1) / 2;

  // Serialize indent stack size (1 byte), clamped to both 255 and buffer capacity
  uint8_t size = (uint8_t)s->indents.size;
  if (size > 255) size = 255;
  if (size > max_entries) size = (uint8_t)max_entries;
  buffer[pos++] = (char)size;

  DEBUG_LOG("[SCANNER_STATE]     packed stack size: %u (original: %u, max_entries: %u)\n",
    size, s->indents.size, max_entries);

  // Serialize each indent as uint16_t (2 bytes, little-endian)
  for (uint32_t i = 0; i < size; i++) {
    uint16_t indent = s->indents.contents[i];
    buffer[pos++] = (char)(indent & 0xFF);
    buffer[pos++] = (char)((indent >> 8) & 0xFF);
    DEBUG_LOG("[SCANNER_STATE]       packed[%u]: %d (bytes: 0x%02x 0x%02x)\n",
      i, indent, (indent & 0xFF), ((indent >> 8) & 0xFF));
  }

  DEBUG_LOG("[SCANNER_STATE]     <<< SERIALIZE complete: %u bytes written to buffer\n", pos);

  return pos;
}

void tree_sitter_kippy_external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {
  Scanner *s = (Scanner *)payload;

  DEBUG_LOG("[SCANNER_STATE] >>> DESERIALIZE (length=%u)\n", length);

  array_clear(&s->indents);

  // Default to line start state for empty buffer or fresh initialization
  s->at_line_start = true;
  s->seen_non_whitespace = false;
  s->current_indent = 0;
  s->pending_newlines = 0;

  if (length > 0) {
    unsigned pos = 0;

    // Restore flags (1 byte): bit 0 = at_line_start, bit 1 = seen_non_whitespace
    uint8_t flags = (uint8_t)buffer[pos++];
    s->at_line_start = (flags & 0x01) != 0;
    s->seen_non_whitespace = (flags & 0x02) != 0;

    DEBUG_LOG("[SCANNER_STATE]     restored flags: 0x%02x -> at_line_start=%d, seen_non_ws=%d\n",
      flags, s->at_line_start, s->seen_non_whitespace);

    // Restore pending_newlines (2 bytes, little-endian)
    if (pos + 2 <= length) {
      s->pending_newlines = (uint16_t)(uint8_t)buffer[pos] | ((uint16_t)(uint8_t)buffer[pos + 1] << 8);
      pos += 2;
      DEBUG_LOG("[SCANNER_STATE]     restored pending_newlines: %d\n", s->pending_newlines);
    }

    if (pos < length) {
      uint8_t stack_size = (uint8_t)buffer[pos++];

      DEBUG_LOG("[SCANNER_STATE]     reading indent stack: size=%u\n", stack_size);

      // Read indentation stack (each entry is 2 bytes: uint16_t in little-endian)
      // Cast via uint8_t first to avoid sign-extension on platforms where char is signed
      for (uint8_t i = 0; i < stack_size && pos + 2 <= length; i++) {
        uint16_t indent = (uint16_t)(uint8_t)buffer[pos] | ((uint16_t)(uint8_t)buffer[pos + 1] << 8);
        pos += 2;
        array_push(&s->indents, indent);
        DEBUG_LOG("[SCANNER_STATE]       stack[%u] = %d\n", i, indent);
      }
    }
  } else {
    // Empty buffer: initialize with base level 0
    uint16_t base = 0;
    array_push(&s->indents, base);
  }

  // Ensure indent stack is never empty (critical: prevents UB in array_back calls)
  if (s->indents.size == 0) {
    DEBUG_LOG("[SCANNER_STATE]     >>> WARNING: indent stack empty after deserialize, pushing base 0\n");
    uint16_t base = 0;
    array_push(&s->indents, base);
  }

  DEBUG_LOG("[SCANNER_STATE]     final state: at_line_start=%d, seen_non_ws=%d, current_indent=%d, pending_newlines=%d, stack_size=%u\n",
    s->at_line_start, s->seen_non_whitespace, s->current_indent, s->pending_newlines, s->indents.size);
  DEBUG_LOG("[SCANNER_STATE]     stack=[");
  for (uint32_t i = 0; i < s->indents.size; i++) {
    DEBUG_LOG("%d%s", s->indents.contents[i], (i < s->indents.size-1) ? ", " : "");
  }
  DEBUG_LOG("]\n");
}

// Count indentation at the beginning of a line
// Uses column-based normalization: tabs and spaces are converted to column positions
// Tab width = 4 (so \t == 4 spaces, semantically)
static inline uint16_t count_indent(TSLexer *lexer) {
  const int TAB_WIDTH = 4;
  uint16_t column = 0;

  while (is_hspace(lexer->lookahead)) {
    if (lexer->lookahead == ' ') {
      column += 1;  // one space = one column
    } else if (lexer->lookahead == '\t') {
      // tab = jump to next tab stop (multiple of TAB_WIDTH)
      column += TAB_WIDTH - (column % TAB_WIDTH);
    }
    lexer->advance(lexer, true);
  }

  return column;  // return column position (semantic indentation level)
}

// Check if the rest of the line is just whitespace (comments are in extras, so already consumed)
static inline bool is_blank_line(TSLexer *lexer) {
  if (is_newline(lexer->lookahead)) {
    DEBUG_LOG("[SCANNER]       is_blank_line check: found newline (0x%02x), returning true\n",
      (unsigned char)lexer->lookahead);
    return true;
  }
  if (lexer->lookahead == '\0') {
    DEBUG_LOG("[SCANNER]       is_blank_line check: found EOF, returning true\n");
    return true;
  }
  DEBUG_LOG("[SCANNER]       is_blank_line check: lookahead=0x%02x ('%c') - not blank\n",
    (unsigned char)lexer->lookahead,
    (lexer->lookahead >= 32 && lexer->lookahead < 127) ? (char)lexer->lookahead : '?');
  return false;
}

// Emit DEDENT tokens for decreased indentation
static inline bool emit_dedent(Scanner *s, TSLexer *lexer, const bool *valid_symbols) {
  if (!valid_symbols[DEDENT]) {
    DEBUG_LOG("[SCANNER] DEDENT not valid\n");
    return false;
  }

  if (s->indents.size > 1 && s->current_indent < *array_back(&s->indents)) {
    uint16_t top_before = *array_back(&s->indents);
    DEBUG_LOG("[SCANNER] >>> EMIT DEDENT boundary: stack_size=%u, current=%d, top=%d\n",
      s->indents.size, s->current_indent, top_before);
    array_pop(&s->indents);
    uint16_t top_after = *array_back(&s->indents);

    /* Invariant: stack never empty */
    if (s->indents.size == 0) {
      DEBUG_LOG("[SCANNER] !!! INVARIANT VIOLATION: indent stack is empty after pop!\n");
    }
    /* Invariant: stack is non-decreasing */
    if (s->indents.size >= 2 &&
        s->indents.contents[s->indents.size - 2] > s->indents.contents[s->indents.size - 1]) {
      DEBUG_LOG("[SCANNER] !!! INVARIANT VIOLATION: non-decreasing violated at stack[%u]=%d > stack[%u]=%d\n",
        s->indents.size - 2, s->indents.contents[s->indents.size - 2],
        s->indents.size - 1, s->indents.contents[s->indents.size - 1]);
    }

    DEBUG_LOG("[SCANNER]     STACK after pop: size=%u, [", s->indents.size);
    for (uint32_t i = 0; i < s->indents.size; i++) {
      DEBUG_LOG("%d%s", s->indents.contents[i], (i < s->indents.size-1) ? ", " : "");
    }
    DEBUG_LOG("]\n");

    lexer->result_symbol = DEDENT;
    DEBUG_LOG("[SCANNER]     set result_symbol=DEDENT (value=%d), new_stack_top=%d\n", DEDENT, top_after);
    lexer->mark_end(lexer);
    DEBUG_LOG("[SCANNER]     mark_end() called, lookahead=0x%02x\n", (unsigned char)lexer->lookahead);
    return true;
  }
  DEBUG_LOG("[SCANNER] DEDENT check failed: size=%u, current=%d, top=%d\n",
    s->indents.size, s->current_indent, s->indents.size > 0 ? *array_back(&s->indents) : -1);
  return false;
}

// Emit INDENT token for increased indentation
static inline bool emit_indent(Scanner *s, TSLexer *lexer, const bool *valid_symbols) {
  if (!valid_symbols[INDENT]) {
    DEBUG_LOG("[SCANNER] INDENT not valid\n");
    return false;
  }

  if (s->current_indent > *array_back(&s->indents)) {
    uint16_t top_before = *array_back(&s->indents);
    DEBUG_LOG("[SCANNER] >>> EMIT INDENT boundary: stack_size=%u, top=%d, current=%d\n",
      s->indents.size, top_before, s->current_indent);

    /* Invariant: new indent must be > previous top (strictly non-decreasing) */
    if (s->current_indent <= top_before) {
      DEBUG_LOG("[SCANNER] !!! INVARIANT VIOLATION: new_indent=%d not > top=%d\n",
        s->current_indent, top_before);
    }

    array_push(&s->indents, s->current_indent);

    /* Invariant: stack never empty */
    if (s->indents.size == 0) {
      DEBUG_LOG("[SCANNER] !!! INVARIANT VIOLATION: indent stack is empty after push!\n");
    }

    DEBUG_LOG("[SCANNER]     STACK after push: size=%u, [", s->indents.size);
    for (uint32_t i = 0; i < s->indents.size; i++) {
      DEBUG_LOG("%d%s", s->indents.contents[i], (i < s->indents.size-1) ? ", " : "");
    }
    DEBUG_LOG("]\n");

    lexer->result_symbol = INDENT;
    DEBUG_LOG("[SCANNER]     set result_symbol=INDENT (value=%d), stack_size_after=%u\n", INDENT, s->indents.size);
    lexer->mark_end(lexer);
    DEBUG_LOG("[SCANNER]     mark_end() called, lookahead=0x%02x, col=%u\n",
      (unsigned char)lexer->lookahead, lexer->get_column(lexer));
    return true;
  }
  DEBUG_LOG("[SCANNER] INDENT check failed: current=%d, top=%d\n", s->current_indent, *array_back(&s->indents));
  return false;
}

bool tree_sitter_kippy_external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
  Scanner *s = (Scanner *)payload;
  const char *no_token_reason = NULL;  /* Reason code for return false */

  DEBUG_LOG("[SCANNER] ENTRY: col=%u, at_line_start=%d, seen_non_ws=%d, lookahead='%c' (0x%02x), stack_size=%u\n",
    lexer->get_column(lexer), s->at_line_start, s->seen_non_whitespace,
    (lexer->lookahead >= 32 && lexer->lookahead < 127) ? (char)lexer->lookahead : '?',
    (unsigned char)lexer->lookahead,
    s->indents.size);
  DEBUG_LOG("[SCANNER]       valid: INDENT=%d, DEDENT=%d, NEWLINE=%d, current_indent=%d\n",
    valid_symbols[INDENT], valid_symbols[DEDENT], valid_symbols[NEWLINE], s->current_indent);

  // Recompute at_line_start and seen_non_whitespace based on lexer position
  // Serialized state cannot be trusted across resume points
  if (lexer->get_column(lexer) > 0) {
    s->at_line_start = false;
  } else {
    // At column 0: we are at line start
    // Reset both flags to allow full indentation handling
    // (needed to emit multiple DEDENTs without input consumption)
    s->at_line_start = true;
    s->seen_non_whitespace = false;
  }

  /* Handle EOF: emit remaining DEDENTs to close all indented blocks */
  if (lexer->lookahead == '\0') {
    if (s->indents.size > 1 && valid_symbols[DEDENT]) {
      DEBUG_LOG("[SCANNER] !!! EOF DEDENT: stack_size=%u, emitting remaining DEDENT\n", s->indents.size);
      return emit_dedent(s, lexer, valid_symbols);
    }
    DEBUG_LOG("[SCANNER] !!! EOF: indent stack closed (size=%u), no more tokens\n", s->indents.size);
    return false;
  }

  /* Log when parser asks for layout closure at EOF */
  if (lexer->lookahead == '\0' && (valid_symbols[NEWLINE] || valid_symbols[DEDENT])) {
    DEBUG_LOG("[SCANNER] !!! EOF LAYOUT REQUEST: lookahead=0x00, NEWLINE=%d, DEDENT=%d, stack_size=%u, current_indent=%d\n",
      valid_symbols[NEWLINE], valid_symbols[DEDENT], s->indents.size, s->current_indent);
  }

  // At line start, only consume indentation if INDENT or DEDENT could be emitted.
  // Otherwise, leave whitespace to be handled by the /[ \t]/ extras rule.
  // Also verify we're actually at column 0 (start of line), not in the middle.
  if (s->at_line_start && !s->seen_non_whitespace && lexer->get_column(lexer) == 0) {
    // Loop through blank lines to accumulate pending_newlines and find next non-blank line
    while (true) {
      // Always analyze indentation at line start, regardless of parser state
      uint16_t old_indent = s->current_indent;
      s->current_indent = count_indent(lexer);
      DEBUG_LOG("[SCANNER]     Counted indent: %d (was %d), stack_top: %d, col=%u\n",
        s->current_indent, old_indent, *array_back(&s->indents), lexer->get_column(lexer));
      DEBUG_LOG("[SCANNER]     First non-hspace: 0x%02x ('%c')\n",
        (unsigned char)lexer->lookahead,
        (lexer->lookahead >= 32 && lexer->lookahead < 127) ? (char)lexer->lookahead : '?');

      // Check if this is a blank line (whitespace + newline/comment)
      if (is_blank_line(lexer)) {
        DEBUG_LOG("[SCANNER]     Line is blank (ends with newline/comment)\n");

        // Blank line: consume through the newline and track pending newline
        uint32_t consumed_count = 0;
        while (!is_newline(lexer->lookahead) && lexer->lookahead != '\0') {
          DEBUG_LOG("[SCANNER]         consuming: 0x%02x\n", (unsigned char)lexer->lookahead);
          lexer->advance(lexer, true);
          consumed_count++;
        }
        DEBUG_LOG("[SCANNER]     consumed %u chars until EOL, now at: 0x%02x\n",
          consumed_count, (unsigned char)lexer->lookahead);

        // Consume the newline itself and track it
        bool consumed_newline = false;
        if (lexer->lookahead == '\r') {
          DEBUG_LOG("[SCANNER]     consuming CR\n");
          lexer->advance(lexer, true);
          consumed_newline = true;
        }
        if (lexer->lookahead == '\n') {
          DEBUG_LOG("[SCANNER]     consuming LF\n");
          lexer->advance(lexer, true);
          consumed_newline = true;
        }

        // Track blank line as pending (deferred emission after dedents)
        if (consumed_newline) {
          s->pending_newlines++;
          DEBUG_LOG("[SCANNER]     blank line consumed, pending_newlines now %d (will emit after dedents)\n", s->pending_newlines);
          s->at_line_start = true;
          s->seen_non_whitespace = false;
          // Continue loop to next line without emitting yet
          continue;
        }

        // No newline consumed (EOF case): break out to handle pending tokens
        DEBUG_LOG("[SCANNER]     no newline to consume (at EOF)\n");
        break;
      } else {
        // Non-blank line: exit loop to process dedents/indents
        break;
      }
    } // end blank-line loop

    // Now handle dedents (must be done before indent detection)
    if (valid_symbols[INDENT] || valid_symbols[DEDENT]) {
      if (emit_dedent(s, lexer, valid_symbols)) {
        return true;
      }
    }

    // After dedents, emit one pending NEWLINE if available
    if (s->pending_newlines > 0 && valid_symbols[NEWLINE]) {
      DEBUG_LOG("[SCANNER]     emitting pending NEWLINE after dedents (%d remaining)\n", s->pending_newlines);
      s->pending_newlines--;
      lexer->result_symbol = NEWLINE;
      // Keep at_line_start=true to continue processing next call
      return true;
    }

    // Handle indents
    if (valid_symbols[INDENT] || valid_symbols[DEDENT]) {
      if (emit_indent(s, lexer, valid_symbols)) {
        s->at_line_start = false;
        s->seen_non_whitespace = true;
        return true;
      }

      DEBUG_LOG("[SCANNER]     No INDENT/DEDENT emitted, clearing at_line_start\n");
      s->at_line_start = false;
    } else {
      // INDENT/DEDENT not valid in current parser state.
      // Don't consume indentation; let /[ \t]/ extras handle it.
      DEBUG_LOG("[SCANNER] >>> INDENTATION DECISION: EXTRAS will consume indentation\n");
      DEBUG_LOG("[SCANNER]     Reason: INDENT=%d, DEDENT=%d (neither valid in this parser state)\n",
        valid_symbols[INDENT], valid_symbols[DEDENT]);
      DEBUG_LOG("[SCANNER]     Lookahead: 0x%02x ('%c'), col=%u (indentation will be consumed by /[ \\t]/ rule)\n",
        (unsigned char)lexer->lookahead,
        (lexer->lookahead >= 32 && lexer->lookahead < 127) ? (char)lexer->lookahead : '?',
        lexer->get_column(lexer));
      s->at_line_start = false;
    }
  } else if (s->at_line_start && lexer->get_column(lexer) > 0) {
    // We're at_line_start but not at column 0 (shouldn't happen, but reset the flag just in case)
    DEBUG_LOG("[SCANNER] !!! INCONSISTENT STATE: at_line_start=true but col=%u > 0, resetting\n",
      lexer->get_column(lexer));
    s->at_line_start = false;
  }

  // Skip trailing horizontal whitespace before checking for newline.
  // This prevents ERROR nodes when lines end with tabs/spaces before the newline.
  if (valid_symbols[NEWLINE]) {
    uint32_t hspace_skipped = 0;
    while (is_hspace(lexer->lookahead)) {
      char skipped_char = (char)lexer->lookahead;
      lexer->advance(lexer, true);  // skip as whitespace
      hspace_skipped++;
    }
    if (hspace_skipped > 0) {
      DEBUG_LOG("[SCANNER]     Skipped %u trailing hspace chars before NEWLINE check\n", hspace_skipped);
    }
  }

  // Check for newlines to mark end of line
  if (valid_symbols[NEWLINE] && is_newline(lexer->lookahead)) {
    DEBUG_LOG("[SCANNER] >>> EMIT NEWLINE boundary: lookahead=0x%02x (newline), col=%u\n",
      (unsigned char)lexer->lookahead, lexer->get_column(lexer));
    if (lexer->lookahead == '\r') {
      DEBUG_LOG("[SCANNER]     advancing past CR\n");
      lexer->advance(lexer, true);
    }
    if (lexer->lookahead == '\n') {
      DEBUG_LOG("[SCANNER]     advancing past LF\n");
      lexer->advance(lexer, true);
    }
    lexer->mark_end(lexer);
    DEBUG_LOG("[SCANNER]     mark_end() called, next lookahead=0x%02x, col=%u\n",
      (unsigned char)lexer->lookahead, lexer->get_column(lexer));
    s->at_line_start = true;
    s->seen_non_whitespace = false;
    lexer->result_symbol = NEWLINE;
    DEBUG_LOG("[SCANNER]     set result_symbol=NEWLINE (value=%d), at_line_start=true\n", NEWLINE);
    return true;
  }

  DEBUG_LOG("[SCANNER] EXIT (no token): reason='%s', at_line_start=%d, seen_non_ws=%d, lookahead=0x%02x\n",
    no_token_reason ? no_token_reason : "no_handler", s->at_line_start, s->seen_non_whitespace,
    (unsigned char)lexer->lookahead);

return_no_token:
  return false;
}
