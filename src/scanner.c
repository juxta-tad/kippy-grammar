#include "tree_sitter/parser.h"
#include "tree_sitter/array.h"
#include <assert.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>

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

// ─────────────────────────────────────────────────────────────────────────
// LAYOUT CONSTANTS
// ─────────────────────────────────────────────────────────────────────────
enum {
  SCANNER_MAGIC = 0x4B495050,    // "KIPP" - magic number for runtime validation
  MAX_INDENT_COLUMN = 10000,      // Maximum indentation column (realistic bound)
  MAX_PENDING_NEWLINES = 50000,   // Maximum buffered blank lines (realistic bound, fits in uint16_t)
  MAX_INDENT_DEPTH = 255,         // Maximum nesting depth (limited by serialization uint8_t size field)
};

enum TokenType {
  NEWLINE,              // end of line (must match grammar externals[0])
  INDENT,               // increased indentation level (must match grammar externals[1])
  DEDENT,               // decreased indentation level (must match grammar externals[2])
};

enum {
  VALID_SYMBOLS_MIN_SIZE = DEDENT + 1,  // valid_symbols array must have at least 3 elements
};

// ─────────────────────────────────────────────────────────────────────────
// COMPILE-TIME INVARIANTS
// ─────────────────────────────────────────────────────────────────────────
_Static_assert(NEWLINE == 0, "Token order must match grammar externals[0]");
_Static_assert(INDENT  == 1, "Token order must match grammar externals[1]");
_Static_assert(DEDENT  == 2, "Token order must match grammar externals[2]");
_Static_assert(DEDENT == INDENT + 1, "Token order must remain contiguous");

// valid_symbols array layout assumptions (enforced by tree-sitter contract, NOT checked at runtime)
// Tree-sitter knows the count (.external_token_count in TSLanguage) but doesn't pass it to scan()
// The scan function receives only the pointer, so we cannot validate the array size at runtime
_Static_assert(VALID_SYMBOLS_MIN_SIZE == 3, "Exactly 3 external tokens defined");

_Static_assert(CHAR_BIT == 8, "Serialization assumes 8-bit bytes");
_Static_assert(sizeof(uint16_t) == 2, "Serialization assumes 16-bit uint16_t");
_Static_assert(sizeof(uint8_t)  == 1, "Serialization assumes 8-bit uint8_t");
_Static_assert(UINT16_MAX == 65535, "Serialization assumes 16-bit uint16_t range");
_Static_assert(UINT8_MAX  == 255,   "Serialization assumes 8-bit uint8_t range");

_Static_assert(MAX_INDENT_COLUMN < UINT16_MAX, "Max indent must fit in uint16_t");
_Static_assert(MAX_PENDING_NEWLINES < UINT16_MAX, "Max pending newlines must fit in uint16_t");
_Static_assert(MAX_INDENT_DEPTH <= UINT8_MAX, "Max indent depth must fit in serialization size field");

enum {
  SERIALIZED_STACK_ENTRY_BYTES = 2,      // each indent level is uint16_t
  SERIALIZED_SIZE_FIELD_BYTES  = 1,      // size field is uint8_t
  SCANNER_HEADER_BYTES = 1 + 2 + 2 + 1,  // flags + pending_newlines + current_indent + size
};

_Static_assert(
  SCANNER_HEADER_BYTES == 6,
  "Header size must match serialization format"
);

_Static_assert(
  TREE_SITTER_SERIALIZATION_BUFFER_SIZE >= SCANNER_HEADER_BYTES + SERIALIZED_STACK_ENTRY_BYTES,
  "Serialization buffer too small for base indent stack"
);

_Static_assert(
  MAX_INDENT_DEPTH * SERIALIZED_STACK_ENTRY_BYTES <= TREE_SITTER_SERIALIZATION_BUFFER_SIZE - SCANNER_HEADER_BYTES,
  "Max indent depth must fit in serialization buffer"
);

// ─────────────────────────────────────────────────────────────────────────
// PAYLOAD LIFETIME & INTERFACE ASSUMPTIONS
// ─────────────────────────────────────────────────────────────────────────
/*
  PAYLOAD LIFETIME (tree-sitter contract):
  - create() called exactly once before any other function
  - returned payload is passed unchanged to other functions
  - destroy() called at most once
  - payload is valid Scanner* (or NULL in error cases)

  VALID_SYMBOLS ARRAY (from TSLanguage.external_scanner):
  - Pointer validated with NULL check in scan()
  - Size is GUARANTEED by tree-sitter contract to be at least EXTERNAL_TOKEN_COUNT (3)
  - Actual size not passed to scan() function signature, so cannot be validated at runtime
  - We safely access indices [0], [1], [2] (NEWLINE, INDENT, DEDENT) - guaranteed by contract
  - Each element is bool (non-zero if token type is currently acceptable)

  TSLEXER STRUCT (tree-sitter parser.h):
  - lookahead: int32_t field (current character as int32_t)
  - result_symbol: TSSymbol field (set to token type when match found)
  - advance(lexer, skip): function pointer to advance past current char
  - mark_end(lexer): function pointer to mark end of token
  - eof(): function pointer to check if at end of input (PREFERRED for EOF checks)
  - get_column(lexer): function pointer to get current column (authoritative tab/space handling)

  We validate critical preconditions (NULL checks) in each function.
*/

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
  uint32_t magic;                // Runtime validation: must equal SCANNER_MAGIC
  Array(uint16_t) indents;
  bool at_line_start;
  bool indent_scanned;
  uint16_t current_indent;
  uint16_t pending_newlines;
} Scanner;

static inline void check_indent_invariants(const Scanner *s) {
  assert(s != NULL);
  assert(s->indents.size > 0);                     // Always has at least base level
  assert(s->indents.contents != NULL);             // Contents pointer must be valid
  assert(s->indents.contents[0] == 0);             // Base level is always 0

  // Indent levels must be monotonically increasing
  for (uint32_t i = 1; i < s->indents.size; i++) {
    assert(s->indents.contents[i] > s->indents.contents[i - 1]);
  }
}

void *tree_sitter_kippy_external_scanner_create(void) {
  Scanner *s = (Scanner *)calloc(1, sizeof(Scanner));
  if (!s) {
    return NULL;  // Allocation failure
  }

  s->magic = SCANNER_MAGIC;
  array_init(&s->indents);
  uint16_t base = 0;
  array_push(&s->indents, base);
  s->at_line_start = true;
  s->indent_scanned = false;
  s->current_indent = 0;
  s->pending_newlines = 0;

  check_indent_invariants(s);  // Validate initial state
  return s;
}

void tree_sitter_kippy_external_scanner_destroy(void *payload) {
  if (!payload) return;  // NULL is safe, already freed or never created

  Scanner *s = (Scanner *)payload;
  assert(s->magic == SCANNER_MAGIC);  // Validate payload is valid Scanner*

  array_delete(&s->indents);
  s->magic = 0;  // Invalidate magic to catch use-after-free
  free(s);
}

unsigned tree_sitter_kippy_external_scanner_serialize(void *payload, char *buffer) {
  if (!payload || !buffer) return 0;  // Invalid arguments

  Scanner *s = (Scanner *)payload;
  assert(s->magic == SCANNER_MAGIC);  // Validate payload is valid Scanner*
  unsigned pos = 0;

  uint8_t flags = 0;
  if (s->at_line_start) flags |= 0x01;
  if (s->indent_scanned) flags |= 0x02;
  buffer[pos++] = (char)flags;

  buffer[pos++] = (char)(s->pending_newlines & 0xFF);
  buffer[pos++] = (char)((s->pending_newlines >> 8) & 0xFF);

  buffer[pos++] = (char)(s->current_indent & 0xFF);
  buffer[pos++] = (char)((s->current_indent >> 8) & 0xFF);

  // Indent stack depth is guaranteed to fit in serialization buffer by MAX_INDENT_DEPTH constraint
  assert(s->indents.size <= MAX_INDENT_DEPTH);
  uint8_t size = (uint8_t)s->indents.size;
  buffer[pos++] = (char)size;

  for (uint32_t i = 0; i < size; i++) {
    uint16_t indent = s->indents.contents[i];
    buffer[pos++] = (char)(indent & 0xFF);
    buffer[pos++] = (char)((indent >> 8) & 0xFF);
  }
  return pos;
}

void tree_sitter_kippy_external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {
  if (!payload) return;  // Payload lifetime violation

  Scanner *s = (Scanner *)payload;
  assert(s->magic == SCANNER_MAGIC);  // Validate payload is valid Scanner*
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

  // Validate indent stack invariants after deserialization
  check_indent_invariants(s);
}

static inline uint16_t count_indent(TSLexer *lexer) {
  // Consume all leading horizontal whitespace
  while (is_hspace(lexer->lookahead)) {
    lexer->advance(lexer, true);
  }

  // Get column position from tree-sitter's lexer (authoritative tab/space handling)
  uint32_t col = lexer->get_column(lexer);

  // Clamp to MAX_INDENT_COLUMN to prevent overflow
  return (col > MAX_INDENT_COLUMN) ? MAX_INDENT_COLUMN : (uint16_t)col;
}

static inline bool is_blank_line(TSLexer *lexer) {
  return is_newline(lexer->lookahead) || lexer->eof(lexer);
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
  check_indent_invariants(s);  // State before dedent

  if (!valid_symbols[DEDENT]) return false;

  if (s->indents.size > 1 && s->current_indent < *array_back(&s->indents)) {
    array_pop(&s->indents);
    check_indent_invariants(s);  // State after pop
    lexer->result_symbol = DEDENT;
    lexer->mark_end(lexer);
    return true;
  }
  return false;
}

static inline bool emit_indent(Scanner *s, TSLexer *lexer, const bool *valid_symbols) {
  check_indent_invariants(s);  // State before indent

  if (!valid_symbols[INDENT]) return false;

  if (s->current_indent > *array_back(&s->indents)) {
    // Prevent nesting deeper than what can be serialized
    if (s->indents.size >= MAX_INDENT_DEPTH) {
      return false;  // Too deeply nested, cannot emit INDENT
    }
    array_push(&s->indents, s->current_indent);
    check_indent_invariants(s);  // State after push
    lexer->result_symbol = INDENT;
    lexer->mark_end(lexer);
    return true;
  }
  return false;
}

bool tree_sitter_kippy_external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
  if (!payload || !lexer || !valid_symbols) return false;  // Invalid arguments

  Scanner *s = (Scanner *)payload;
  assert(s->magic == SCANNER_MAGIC);  // Validate payload is valid Scanner*

  DEBUG_LOG("[SCAN] at_line_start=%d indent_scanned=%d lookahead='%c'(0x%x) valid[INDENT]=%d valid[DEDENT]=%d\n",
    s->at_line_start, s->indent_scanned,
    (lexer->lookahead >= 32 && lexer->lookahead < 127) ? lexer->lookahead : '?',
    lexer->lookahead,
    valid_symbols[INDENT], valid_symbols[DEDENT]);

  // ═════════════════════════════════════════════════════════════════════════
  // PHASE 1: EOF HANDLING
  // ═════════════════════════════════════════════════════════════════════════
  // At EOF: first emit any buffered blank-line NEWLINEs, then emit DEDENT tokens
  // to close all open indentation levels.
  if (lexer->eof(lexer)) {
    DEBUG_LOG("[PHASE1] EOF: pending_newlines=%u indents.size=%d\n", s->pending_newlines, s->indents.size);

    // Emit any trailing blank-line NEWLINEs first
    if (s->pending_newlines > 0 && valid_symbols[NEWLINE]) {
      s->pending_newlines--;
      log_emit("EOF_PENDING_NEWLINE", s, lexer);
      lexer->result_symbol = NEWLINE;
      return true;
    }

    // Then emit DEDENT tokens to close all indentation levels
    s->current_indent = 0;
    if (s->indents.size > 1 && valid_symbols[DEDENT]) {
      return emit_dedent(s, lexer, valid_symbols);
    }

    // All indents closed and no more newlines. Stop.
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
            if (s->pending_newlines < MAX_PENDING_NEWLINES) {
              s->pending_newlines++;
            }
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
  // ═════════════════════════════════════════════════════════════════════════
  // PHASE 3: ORDINARY NEWLINE DETECTION
  // ═════════════════════════════════════════════════════════════════════════
  // NOTE: Do NOT consume spaces here. If we consume spaces and then discover
  // the next character is not a newline, we've violated the scanner contract
  // (return false means no input was consumed). Only consume the newline itself.
  DEBUG_LOG("[PHASE3] checking for NEWLINE\n");
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
