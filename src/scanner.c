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

#if defined(__EMSCRIPTEN__) || defined(WASM_BUILD) || defined(__wasm__)
  #define IS_WASM 1
#else
  #define IS_WASM 0
#endif

#if IS_WASM
  #define DEBUG_LOG(...)
#else
  #include <stdio.h>
  #define DEBUG_LOG(...) fprintf(stderr, __VA_ARGS__)
#endif

enum TokenType {
  NEWLINE,              // end of line (must match grammar externals[0])
  INDENT,               // increased indentation level (must match grammar externals[1])
  DEDENT,               // decreased indentation level (must match grammar externals[2])
};

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
  Array(uint16_t) indents;
  bool at_line_start;
  bool indent_scanned;
  uint16_t current_indent;
  uint16_t pending_newlines;
} Scanner;

static inline void check_indent_invariants(const Scanner *s, const char *context) {
  if (s->indents.size == 0) return;
  if (s->indents.contents[0] != 0) return;
  for (uint32_t i = 1; i < s->indents.size; i++) {
    if (s->indents.contents[i] < s->indents.contents[i - 1]) return;
  }
}

void *tree_sitter_kippy_external_scanner_create(void) {
  Scanner *s = (Scanner *)calloc(1, sizeof(Scanner));
  if (s) {
    array_init(&s->indents);
    uint16_t base = 0;
    array_push(&s->indents, base);
    s->at_line_start = true;
    s->indent_scanned = false;
    s->current_indent = 0;
    s->pending_newlines = 0;
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

  uint8_t flags = 0;
  if (s->at_line_start) flags |= 0x01;
  if (s->indent_scanned) flags |= 0x02;
  buffer[pos++] = (char)flags;

  buffer[pos++] = (char)(s->pending_newlines & 0xFF);
  buffer[pos++] = (char)((s->pending_newlines >> 8) & 0xFF);

  buffer[pos++] = (char)(s->current_indent & 0xFF);
  buffer[pos++] = (char)((s->current_indent >> 8) & 0xFF);

  uint32_t max_entries = (TREE_SITTER_SERIALIZATION_BUFFER_SIZE - 1 - 2 - 2 - 1) / 2;
  uint8_t size = (uint8_t)s->indents.size;
  if (size > 255) size = 255;
  if (size > max_entries) size = (uint8_t)max_entries;
  buffer[pos++] = (char)size;

  for (uint32_t i = 0; i < size; i++) {
    uint16_t indent = s->indents.contents[i];
    buffer[pos++] = (char)(indent & 0xFF);
    buffer[pos++] = (char)((indent >> 8) & 0xFF);
  }
  return pos;
}

void tree_sitter_kippy_external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {
  Scanner *s = (Scanner *)payload;
  array_clear(&s->indents);

  s->at_line_start = true;
  s->indent_scanned = false;
  s->current_indent = 0;
  s->pending_newlines = 0;

  if (length > 0) {
    unsigned pos = 0;

    uint8_t flags = (uint8_t)buffer[pos++];
    s->at_line_start = (flags & 0x01) != 0;
    s->indent_scanned = (flags & 0x02) != 0;

    if (pos + 2 <= length) {
      s->pending_newlines = (uint16_t)(uint8_t)buffer[pos] | ((uint16_t)(uint8_t)buffer[pos + 1] << 8);
      pos += 2;
    }

    if (pos + 2 <= length) {
      s->current_indent = (uint16_t)(uint8_t)buffer[pos] | ((uint16_t)(uint8_t)buffer[pos + 1] << 8);
      pos += 2;
    }

    if (pos < length) {
      uint8_t stack_size = (uint8_t)buffer[pos++];
      for (uint8_t i = 0; i < stack_size && pos + 2 <= length; i++) {
        uint16_t indent = (uint16_t)(uint8_t)buffer[pos] | ((uint16_t)(uint8_t)buffer[pos + 1] << 8);
        pos += 2;
        array_push(&s->indents, indent);
      }
    }
  }

  if (s->indents.size == 0) {
    uint16_t base = 0;
    array_push(&s->indents, base);
  }
}

static inline uint16_t count_indent(TSLexer *lexer) {
  const int TAB_WIDTH = 4;
  uint16_t column = 0;

  while (is_hspace(lexer->lookahead)) {
    if (lexer->lookahead == ' ') {
      column += 1;
    } else if (lexer->lookahead == '\t') {
      column += TAB_WIDTH - (column % TAB_WIDTH);
    }
    lexer->advance(lexer, true);
  }

  return column;
}

static inline bool is_blank_line(TSLexer *lexer) {
  return is_newline(lexer->lookahead) || lexer->lookahead == '\0';
}

static inline void log_emit(const char *name, Scanner *s, TSLexer *lexer) {
  DEBUG_LOG(
    "[EMIT %s] lookahead='%c'(0x%x) at_line_start=%d indent_scanned=%d current_indent=%u top=%u size=%u pending_nl=%u\n",
    name,
    (lexer->lookahead >= 32 && lexer->lookahead < 127) ? lexer->lookahead : '?',
    lexer->lookahead,
    s->at_line_start,
    s->indent_scanned,
    s->current_indent,
    s->indents.size ? *array_back(&s->indents) : 0,
    s->indents.size,
    s->pending_newlines
  );
}

static inline bool emit_dedent(Scanner *s, TSLexer *lexer, const bool *valid_symbols) {
  if (!valid_symbols[DEDENT]) return false;

  if (s->indents.size > 1 && s->current_indent < *array_back(&s->indents)) {
    array_pop(&s->indents);
    lexer->result_symbol = DEDENT;
    lexer->mark_end(lexer);
    return true;
  }
  return false;
}

static inline bool emit_indent(Scanner *s, TSLexer *lexer, const bool *valid_symbols) {
  if (!valid_symbols[INDENT]) return false;

  if (s->current_indent > *array_back(&s->indents)) {
    array_push(&s->indents, s->current_indent);
    lexer->result_symbol = INDENT;
    lexer->mark_end(lexer);
    return true;
  }
  return false;
}

bool tree_sitter_kippy_external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
  Scanner *s = (Scanner *)payload;

  DEBUG_LOG("[SCAN] at_line_start=%d indent_scanned=%d lookahead='%c'(0x%x) valid[INDENT]=%d valid[DEDENT]=%d\n",
    s->at_line_start, s->indent_scanned,
    (lexer->lookahead >= 32 && lexer->lookahead < 127) ? lexer->lookahead : '?',
    lexer->lookahead,
    valid_symbols[INDENT], valid_symbols[DEDENT]);

  // ═════════════════════════════════════════════════════════════════════════
  // PHASE 1: EOF DEDENTS
  // ═════════════════════════════════════════════════════════════════════════
  if (lexer->lookahead == '\0') {
    DEBUG_LOG("[PHASE1] EOF: emitting dedents (stack size=%d)\n", s->indents.size);
    s->current_indent = 0;
    if (s->indents.size > 1 && valid_symbols[DEDENT]) {
      return emit_dedent(s, lexer, valid_symbols);
    }
    return false;
  }

  // ═════════════════════════════════════════════════════════════════════════
  // PHASE 2: LINE-START LAYOUT HANDLING
  // ═════════════════════════════════════════════════════════════════════════
  bool can_do_layout = valid_symbols[INDENT] || valid_symbols[DEDENT];

  DEBUG_LOG("[PHASE2] at_line_start=%d can_do_layout=%d\n", s->at_line_start, can_do_layout);

  if (s->at_line_start && can_do_layout) {

    if (!s->indent_scanned) {
      while (true) {
        s->current_indent = count_indent(lexer);

        // Check if this is a purely blank line
        if (is_blank_line(lexer)) {
          bool consumed_newline = false;
          if (lexer->lookahead == '\r') {
            lexer->advance(lexer, true);
            consumed_newline = true;
          }
          if (lexer->lookahead == '\n') {
            lexer->advance(lexer, true);
            consumed_newline = true;
          }

          if (consumed_newline) {
            s->pending_newlines++;
            s->at_line_start = true;
            s->indent_scanned = false;
            continue;
          }
          break;
        }

        break;
      }

      s->indent_scanned = true;
    }

    if (emit_dedent(s, lexer, valid_symbols)) {
      log_emit("DEDENT", s, lexer);
      return true;
    }

    if (s->pending_newlines > 0 && valid_symbols[NEWLINE]) {
      s->pending_newlines--;
      log_emit("PENDING_NEWLINE", s, lexer);
      lexer->result_symbol = NEWLINE;
      return true;
    }

    if (emit_indent(s, lexer, valid_symbols)) {
      log_emit("INDENT", s, lexer);
      s->at_line_start = false;
      return true;
    }

    s->at_line_start = false;
    DEBUG_LOG("[PHASE2] exiting, setting at_line_start=false\n");
  }

  // ═════════════════════════════════════════════════════════════════════════
  // PHASE 3: ORDINARY NEWLINE DETECTION
  // ═════════════════════════════════════════════════════════════════════════
  DEBUG_LOG("[PHASE3] checking for NEWLINE\n");
  if (valid_symbols[NEWLINE]) {
    while (is_hspace(lexer->lookahead)) {
      lexer->advance(lexer, true);
    }
  }

  if (valid_symbols[NEWLINE] && is_newline(lexer->lookahead)) {
    if (lexer->lookahead == '\r') {
      lexer->advance(lexer, false);
    }
    if (lexer->lookahead == '\n') {
      lexer->advance(lexer, false);
    }
    lexer->mark_end(lexer);
    s->at_line_start = true;
    s->indent_scanned = false;
    lexer->result_symbol = NEWLINE;
    log_emit("NEWLINE", s, lexer);
    return true;
  }

  DEBUG_LOG("[SCAN] No token emitted\n");
  return false;
}
