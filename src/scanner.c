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

// ─────────────────────────────────────────────────────────────────────────
// SCANNER STATE STRUCT
// ─────────────────────────────────────────────────────────────────────────

typedef struct {
  Array(uint16_t) indents;        // dynamic stack of indentation levels (column positions)
  bool at_line_start;             // are we at the start of a logical line?
  bool indent_scanned;            // have we already scanned indentation for this line?
  uint16_t current_indent;        // indentation of current line
  uint16_t pending_newlines;      // blank lines to emit after dedents
} Scanner;

// ─────────────────────────────────────────────────────────────────────────
// INVARIANT CHECKS
// ─────────────────────────────────────────────────────────────────────────

// Invariant 1: Indent stack is never empty
// Invariant 2: Base indentation is always 0
// Invariant 3: Stack is strictly non-decreasing (each level >= previous)
static inline void check_indent_invariants(const Scanner *s, const char *context) {
  // INV1: Stack never empty
  if (s->indents.size == 0) {
    DEBUG_LOG("[INVARIANT] !!! VIOLATION at %s: indents.size == 0 (should be >= 1)\n", context);
    return;
  }

  // INV2: Base level is 0
  if (s->indents.contents[0] != 0) {
    DEBUG_LOG("[INVARIANT] !!! VIOLATION at %s: indents[0] = %d (should be 0)\n",
      context, s->indents.contents[0]);
    return;
  }

  // INV3: Stack is non-decreasing
  for (uint32_t i = 1; i < s->indents.size; i++) {
    if (s->indents.contents[i] < s->indents.contents[i - 1]) {
      DEBUG_LOG("[INVARIANT] !!! VIOLATION at %s: indents[%u]=%d < indents[%u]=%d (should be non-decreasing)\n",
        context, i, s->indents.contents[i], i - 1, s->indents.contents[i - 1]);
      return;
    }
  }

  DEBUG_LOG("[INVARIANT] OK at %s: size=%u, base=%d, stack=[",
    context, s->indents.size, s->indents.contents[0]);
  for (uint32_t i = 0; i < s->indents.size; i++) {
    DEBUG_LOG("%d%s", s->indents.contents[i], (i < s->indents.size - 1) ? ", " : "");
  }
  DEBUG_LOG("]\n");
}

// Invariant: current_indent is only meaningful when at_line_start or during line-start scan
// (This is implicit in the code structure, but we can check in debug mode)
static inline void check_current_indent_validity(const Scanner *s, bool in_line_start_phase, const char *context) {
  if (!in_line_start_phase && s->at_line_start) {
    // During line-start phase, current_indent should be set by count_indent()
    DEBUG_LOG("[INVARIANT] current_indent=%d (valid: in line-start phase)\n", s->current_indent);
  } else if (in_line_start_phase) {
    DEBUG_LOG("[INVARIANT] current_indent=%d (valid: after line-start scan)\n", s->current_indent);
  } else {
    DEBUG_LOG("[INVARIANT] current_indent=%d (not in line-start, may be stale)\n", s->current_indent);
  }
}

void *tree_sitter_kippy_external_scanner_create(void) {
  Scanner *s = (Scanner *)calloc(1, sizeof(Scanner));
  if (s) {
    array_init(&s->indents);
    // Base indentation is 0 (INV2)
    uint16_t base = 0;
    array_push(&s->indents, base);
    s->at_line_start = true;
    s->indent_scanned = false;
    s->current_indent = 0;
    s->pending_newlines = 0;

    DEBUG_LOG("[STATE] >>> CREATE\n");
    DEBUG_LOG("[STATE]     at_line_start=%d, indent_scanned=%d, current_indent=%d, pending_newlines=%d\n",
      s->at_line_start, s->indent_scanned, s->current_indent, s->pending_newlines);
    check_indent_invariants(s, "CREATE");
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

  DEBUG_LOG("[STATE] >>> SERIALIZE (before packing)\n");
  DEBUG_LOG("[STATE]     at_line_start=%d, indent_scanned=%d, current_indent=%d, pending_newlines=%d\n",
    s->at_line_start, s->indent_scanned, s->current_indent, s->pending_newlines);
  DEBUG_LOG("[STATE]     stack_size=%u, stack=[", s->indents.size);
  for (uint32_t i = 0; i < s->indents.size; i++) {
    DEBUG_LOG("%d%s", s->indents.contents[i], (i < s->indents.size-1) ? ", " : "");
  }
  DEBUG_LOG("]\n");

  // Serialize flags (1 byte): bit 0 = at_line_start, bit 1 = indent_scanned
  uint8_t flags = 0;
  if (s->at_line_start) flags |= 0x01;
  if (s->indent_scanned) flags |= 0x02;
  buffer[pos++] = (char)flags;

  // Serialize pending_newlines (2 bytes, little-endian)
  buffer[pos++] = (char)(s->pending_newlines & 0xFF);
  buffer[pos++] = (char)((s->pending_newlines >> 8) & 0xFF);

  // Serialize current_indent (2 bytes, little-endian)
  buffer[pos++] = (char)(s->current_indent & 0xFF);
  buffer[pos++] = (char)((s->current_indent >> 8) & 0xFF);

  DEBUG_LOG("[STATE]     packed flags: 0x%02x (at_line_start=%d, indent_scanned=%d)\n",
    flags, (flags & 0x01) != 0, (flags & 0x02) != 0);
  DEBUG_LOG("[STATE]     packed pending_newlines: %d (bytes: 0x%02x 0x%02x)\n",
    s->pending_newlines, (s->pending_newlines & 0xFF), ((s->pending_newlines >> 8) & 0xFF));
  DEBUG_LOG("[STATE]     packed current_indent: %d (bytes: 0x%02x 0x%02x)\n",
    s->current_indent, (s->current_indent & 0xFF), ((s->current_indent >> 8) & 0xFF));

  // Calculate maximum number of entries that fit in buffer (after flags + pending_newlines + current_indent)
  uint32_t max_entries = (TREE_SITTER_SERIALIZATION_BUFFER_SIZE - 1 - 2 - 2 - 1) / 2;

  // Serialize indent stack size (1 byte), clamped to both 255 and buffer capacity
  uint8_t size = (uint8_t)s->indents.size;
  if (size > 255) size = 255;
  if (size > max_entries) size = (uint8_t)max_entries;
  buffer[pos++] = (char)size;

  DEBUG_LOG("[STATE]     packed stack size: %u (original: %u, max_entries: %u)\n",
    size, s->indents.size, max_entries);

  // Serialize each indent as uint16_t (2 bytes, little-endian)
  for (uint32_t i = 0; i < size; i++) {
    uint16_t indent = s->indents.contents[i];
    buffer[pos++] = (char)(indent & 0xFF);
    buffer[pos++] = (char)((indent >> 8) & 0xFF);
    DEBUG_LOG("[STATE]       packed[%u]: %d (bytes: 0x%02x 0x%02x)\n",
      i, indent, (indent & 0xFF), ((indent >> 8) & 0xFF));
  }

  DEBUG_LOG("[STATE]     <<< SERIALIZE complete: %u bytes written to buffer\n", pos);

  return pos;
}

void tree_sitter_kippy_external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {
  Scanner *s = (Scanner *)payload;

  DEBUG_LOG("[STATE] >>> DESERIALIZE (length=%u)\n", length);

  array_clear(&s->indents);

  // Default to line start state for empty buffer or fresh initialization
  s->at_line_start = true;
  s->indent_scanned = false;
  s->current_indent = 0;
  s->pending_newlines = 0;

  if (length > 0) {
    unsigned pos = 0;

    // Restore flags (1 byte): bit 0 = at_line_start, bit 1 = indent_scanned
    uint8_t flags = (uint8_t)buffer[pos++];
    s->at_line_start = (flags & 0x01) != 0;
    s->indent_scanned = (flags & 0x02) != 0;

    DEBUG_LOG("[STATE]     restored flags: 0x%02x -> at_line_start=%d, indent_scanned=%d\n",
      flags, s->at_line_start, s->indent_scanned);

    // Restore pending_newlines (2 bytes, little-endian)
    if (pos + 2 <= length) {
      s->pending_newlines = (uint16_t)(uint8_t)buffer[pos] | ((uint16_t)(uint8_t)buffer[pos + 1] << 8);
      pos += 2;
      DEBUG_LOG("[STATE]     restored pending_newlines: %d\n", s->pending_newlines);
    }

    // Restore current_indent (2 bytes, little-endian)
    if (pos + 2 <= length) {
      s->current_indent = (uint16_t)(uint8_t)buffer[pos] | ((uint16_t)(uint8_t)buffer[pos + 1] << 8);
      pos += 2;
      DEBUG_LOG("[STATE]     restored current_indent: %d\n", s->current_indent);
    }

    if (pos < length) {
      uint8_t stack_size = (uint8_t)buffer[pos++];

      DEBUG_LOG("[STATE]     reading indent stack: size=%u\n", stack_size);

      // Read indentation stack (each entry is 2 bytes: uint16_t in little-endian)
      // Cast via uint8_t first to avoid sign-extension on platforms where char is signed
      for (uint8_t i = 0; i < stack_size && pos + 2 <= length; i++) {
        uint16_t indent = (uint16_t)(uint8_t)buffer[pos] | ((uint16_t)(uint8_t)buffer[pos + 1] << 8);
        pos += 2;
        array_push(&s->indents, indent);
        DEBUG_LOG("[STATE]       stack[%u] = %d\n", i, indent);
      }
    }
  } else {
    // Empty buffer: initialize with base level 0
    uint16_t base = 0;
    array_push(&s->indents, base);
  }

  // Ensure indent stack is never empty (critical: prevents UB in array_back calls)
  if (s->indents.size == 0) {
    DEBUG_LOG("[STATE]     >>> WARNING: indent stack empty after deserialize, pushing base 0\n");
    uint16_t base = 0;
    array_push(&s->indents, base);
  }

  DEBUG_LOG("[STATE]     final state: at_line_start=%d, indent_scanned=%d, current_indent=%d, pending_newlines=%d, stack_size=%u\n",
    s->at_line_start, s->indent_scanned, s->current_indent, s->pending_newlines, s->indents.size);
  DEBUG_LOG("[STATE]     stack=[");
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
    DEBUG_LOG("[       is_blank_line check: found newline (0x%02x), returning true\n",
      (unsigned char)lexer->lookahead);
    return true;
  }
  if (lexer->lookahead == '\0') {
    DEBUG_LOG("[       is_blank_line check: found EOF, returning true\n");
    return true;
  }
  DEBUG_LOG("[       is_blank_line check: lookahead=0x%02x ('%c') - not blank\n",
    (unsigned char)lexer->lookahead,
    (lexer->lookahead >= 32 && lexer->lookahead < 127) ? (char)lexer->lookahead : '?');
  return false;
}

// Emit DEDENT tokens for decreased indentation
// Precondition: current_indent < stack_top (indentation decreased)
// Postcondition: stack_size decreases by 1, stack remains non-decreasing
static inline bool emit_dedent(Scanner *s, TSLexer *lexer, const bool *valid_symbols) {
  if (!valid_symbols[DEDENT]) {
    DEBUG_LOG("[ DEDENT not valid\n");
    return false;
  }

  if (s->indents.size > 1 && s->current_indent < *array_back(&s->indents)) {
    uint16_t top_before = *array_back(&s->indents);
    DEBUG_LOG("[ >>> EMIT DEDENT: stack_size=%u, current=%d, top_before=%d\n",
      s->indents.size, s->current_indent, top_before);

    check_indent_invariants(s, "DEDENT_PRECONDITION");

    array_pop(&s->indents);
    uint16_t top_after = *array_back(&s->indents);

    DEBUG_LOG("[     after pop: size=%u, top_after=%d\n", s->indents.size, top_after);

    check_indent_invariants(s, "DEDENT_POSTCONDITION");

    lexer->result_symbol = DEDENT;
    DEBUG_LOG("[     set result_symbol=DEDENT\n");
    lexer->mark_end(lexer);
    return true;
  }
  DEBUG_LOG("[ DEDENT check failed: size=%u, current=%d, top=%d\n",
    s->indents.size, s->current_indent, s->indents.size > 0 ? *array_back(&s->indents) : -1);
  return false;
}

// Emit INDENT token for increased indentation
// Precondition: current_indent > stack_top (indentation increased)
// Postcondition: stack_size increases by 1, new_indent == current_indent, stack remains non-decreasing
static inline bool emit_indent(Scanner *s, TSLexer *lexer, const bool *valid_symbols) {
  if (!valid_symbols[INDENT]) {
    DEBUG_LOG("[ INDENT not valid\n");
    return false;
  }

  if (s->current_indent > *array_back(&s->indents)) {
    uint16_t top_before = *array_back(&s->indents);
    DEBUG_LOG("[ >>> EMIT INDENT: stack_size=%u, top_before=%d, current=%d\n",
      s->indents.size, top_before, s->current_indent);

    check_indent_invariants(s, "INDENT_PRECONDITION");

    array_push(&s->indents, s->current_indent);

    DEBUG_LOG("[     after push: size=%u, new_top=%d\n", s->indents.size, *array_back(&s->indents));

    check_indent_invariants(s, "INDENT_POSTCONDITION");

    lexer->result_symbol = INDENT;
    DEBUG_LOG("[     set result_symbol=INDENT\n");
    lexer->mark_end(lexer);
    return true;
  }
  DEBUG_LOG("[ INDENT check failed: current=%d, top=%d\n", s->current_indent, *array_back(&s->indents));
  return false;
}

bool tree_sitter_kippy_external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
  Scanner *s = (Scanner *)payload;

  DEBUG_LOG("[ ENTRY: col=%u, at_line_start=%d, indent_scanned=%d, lookahead='%c' (0x%02x), stack_size=%u\n",
    lexer->get_column(lexer), s->at_line_start, s->indent_scanned,
    (lexer->lookahead >= 32 && lexer->lookahead < 127) ? (char)lexer->lookahead : '?',
    (unsigned char)lexer->lookahead,
    s->indents.size);
  DEBUG_LOG("[       valid: INDENT=%d, DEDENT=%d, NEWLINE=%d\n",
    valid_symbols[INDENT], valid_symbols[DEDENT], valid_symbols[NEWLINE]);

  check_indent_invariants(s, "ENTRY");

  // ═════════════════════════════════════════════════════════════════════════
  // PHASE 1: EOF DEDENTS
  // At end of file, emit remaining DEDENT tokens to close all indented blocks
  // ═════════════════════════════════════════════════════════════════════════
  if (lexer->lookahead == '\0') {
    if (s->indents.size > 1 && valid_symbols[DEDENT]) {
      DEBUG_LOG("[P1-EOFDED] >>> EOF DEDENT: stack_size=%u, emitting remaining DEDENT\n", s->indents.size);
      return emit_dedent(s, lexer, valid_symbols);
    }
    DEBUG_LOG("[P1-EOF] EOF reached, indent stack closed (size=%u), no more tokens\n", s->indents.size);
    return false;
  }

  // ═════════════════════════════════════════════════════════════════════════
  // PHASE 2: LINE-START LAYOUT HANDLING
  // At logical line start, handle indentation-based layout tokens.
  // CRITICAL: only scan indentation if INDENT or DEDENT are actually valid.
  // Do NOT include NEWLINE—if only NEWLINE is valid, skip indentation scanning
  // and let phase 3 handle the newline. This prevents consuming indentation
  // without emitting an indentation-based token.
  // ═════════════════════════════════════════════════════════════════════════
  bool can_do_layout = valid_symbols[INDENT] || valid_symbols[DEDENT];

  if (s->at_line_start && can_do_layout) {
    DEBUG_LOG("[P2-LAYOUT] Line-start layout handling (can_do_layout=true)\n");

    // Scan indentation only once per line (including blank line absorption)
    if (!s->indent_scanned) {
      DEBUG_LOG("[P2A-SCAN] Scan indentation and absorb blank lines\n");

      // Loop through blank lines to accumulate pending_newlines and find next non-blank line
      while (true) {
        // Analyze indentation at line start (only called when layout is possible)
        uint16_t old_indent = s->current_indent;
        s->current_indent = count_indent(lexer);
        DEBUG_LOG("[     Counted indent: %d (was %d), stack_top: %d, col=%u\n",
          s->current_indent, old_indent, *array_back(&s->indents), lexer->get_column(lexer));
        DEBUG_LOG("[     First non-hspace: 0x%02x ('%c')\n",
          (unsigned char)lexer->lookahead,
          (lexer->lookahead >= 32 && lexer->lookahead < 127) ? (char)lexer->lookahead : '?');

        // Check if this is a blank line (whitespace + newline/comment)
        if (is_blank_line(lexer)) {
          DEBUG_LOG("[     Line is blank (ends with newline/comment)\n");

          // Blank line: consume through the newline and track pending newline
          uint32_t consumed_count = 0;
          while (!is_newline(lexer->lookahead) && lexer->lookahead != '\0') {
            DEBUG_LOG("[         consuming: 0x%02x\n", (unsigned char)lexer->lookahead);
            lexer->advance(lexer, true);
            consumed_count++;
          }
          DEBUG_LOG("[     consumed %u chars until EOL, now at: 0x%02x\n",
            consumed_count, (unsigned char)lexer->lookahead);

          // Consume the newline itself and track it
          bool consumed_newline = false;
          if (lexer->lookahead == '\r') {
            DEBUG_LOG("[     consuming CR\n");
            lexer->advance(lexer, true);
            consumed_newline = true;
          }
          if (lexer->lookahead == '\n') {
            DEBUG_LOG("[     consuming LF\n");
            lexer->advance(lexer, true);
            consumed_newline = true;
          }

          // Track blank line as pending (deferred emission after dedents)
          if (consumed_newline) {
            s->pending_newlines++;
            DEBUG_LOG("[     blank line consumed, pending_newlines now %d (will emit after dedents)\n", s->pending_newlines);
            s->at_line_start = true;
            s->indent_scanned = false;
            // Continue loop to next line without emitting yet
            continue;
          }

          // No newline consumed (EOF case): break out to handle pending tokens
          DEBUG_LOG("[     no newline to consume (at EOF)\n");
          break;
        } else {
          // Non-blank line: exit loop to process dedents/indents
          break;
        }
      } // end blank-line loop

      // Mark that we've scanned indentation for this line
      s->indent_scanned = true;
      DEBUG_LOG("[P2A-DONE] After scan: current_indent=%d, pending_newlines=%d\n",
        s->current_indent, s->pending_newlines);
      check_indent_invariants(s, "AFTER_SCAN_INDENTATION");
    }

    // Try to emit one DEDENT token (before INDENT, since we dedent first)
    DEBUG_LOG("[P2B-DEDENT] Try DEDENT\n");
    if (emit_dedent(s, lexer, valid_symbols)) {
      return true;
    }

    // After dedents, try to emit one pending NEWLINE (before INDENT)
    DEBUG_LOG("[P2C-PEND] Try pending NEWLINE\n");
    if (s->pending_newlines > 0 && valid_symbols[NEWLINE]) {
      DEBUG_LOG("[P2C-EMIT] emitting pending NEWLINE (%d remaining)\n", s->pending_newlines);
      s->pending_newlines--;
      lexer->result_symbol = NEWLINE;
      // Keep at_line_start=true to continue processing next call
      return true;
    }

    // Try to emit one INDENT token
    DEBUG_LOG("[P2D-INDENT] Try INDENT\n");
    if (emit_indent(s, lexer, valid_symbols)) {
      s->at_line_start = false;
      return true;
    }

    // Layout tokens exhausted, fall through to ordinary newline detection
    DEBUG_LOG("[P2E-DONE] No more layout tokens, clearing at_line_start (current_indent now stale)\n");
    s->at_line_start = false;
    check_indent_invariants(s, "PHASE2_COMPLETE");
  }

  // ═════════════════════════════════════════════════════════════════════════
  // PHASE 3: ORDINARY NEWLINE DETECTION
  // Outside line-start phase. Detect and emit NEWLINE tokens for end-of-line.
  // ═════════════════════════════════════════════════════════════════════════
  DEBUG_LOG("[P3-NEWLINE] Ordinary newline detection\n");

  // Skip trailing horizontal whitespace before checking for newline.
  // This prevents ERROR nodes when lines end with tabs/spaces before the newline.
  if (valid_symbols[NEWLINE]) {
    uint32_t hspace_skipped = 0;
    while (is_hspace(lexer->lookahead)) {
      lexer->advance(lexer, true);  // skip as whitespace
      hspace_skipped++;
    }
    if (hspace_skipped > 0) {
      DEBUG_LOG("[P3-SKIP] Skipped %u trailing hspace chars\n", hspace_skipped);
    }
  }

  // Check for newlines to mark end of line
  if (valid_symbols[NEWLINE] && is_newline(lexer->lookahead)) {
    DEBUG_LOG("[P3-EMIT] >>> EMIT NEWLINE: lookahead=0x%02x\n",
      (unsigned char)lexer->lookahead);
    if (lexer->lookahead == '\r') {
      DEBUG_LOG("[P3-EMIT] advancing past CR\n");
      lexer->advance(lexer, true);
    }
    if (lexer->lookahead == '\n') {
      DEBUG_LOG("[P3-EMIT] advancing past LF\n");
      lexer->advance(lexer, true);
    }
    lexer->mark_end(lexer);
    s->at_line_start = true;
    s->indent_scanned = false;
    lexer->result_symbol = NEWLINE;
    DEBUG_LOG("[P3-EMIT] set result_symbol=NEWLINE, at_line_start=true\n");
    return true;
  }

  // ═════════════════════════════════════════════════════════════════════════
  // EXIT: No token produced
  // ═════════════════════════════════════════════════════════════════════════
  DEBUG_LOG("[ EXIT: no token produced\n");
  DEBUG_LOG("[   at_line_start=%d, indent_scanned=%d, lookahead=0x%02x\n",
    s->at_line_start, s->indent_scanned, (unsigned char)lexer->lookahead);
  DEBUG_LOG("[   pending_newlines=%d (blank-line NEWLINEs deferred until DEDENTS finish)\n",
    s->pending_newlines);

  check_indent_invariants(s, "EXIT");

  return false;
}
