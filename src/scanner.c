#include "tree_sitter/parser.h"
#include "tree_sitter/array.h"
#include <assert.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>

/* =========================================================================
 * WASM Compatibility Guards
 * =========================================================================
 * Disable standard I/O debug logging when compiling for WebAssembly
 * to avoid linking unavailable stdio functions.
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

/* =========================================================================
 * Constants & Token Definitions
 * ========================================================================= */
enum {
  SCANNER_MAGIC        = 0x4B495050, // "KIPP" - runtime validation magic number
  MAX_INDENT_COLUMN    = 10000,      // Realistic upper bound for indentation
  MAX_PENDING_NEWLINES = 50000,      // Realistic bound, fits in uint16_t
  MAX_INDENT_DEPTH     = 255,        // Limited by serialization (uint8_t size field)
};

enum TokenType {
  NEWLINE, // End of line                (grammar externals[0])
  INDENT,  // Increased indentation      (grammar externals[1])
  DEDENT,  // Decreased indentation      (grammar externals[2])
};

enum {
  VALID_SYMBOLS_MIN_SIZE = DEDENT + 1, // Must cover all defined TokenTypes
};

/* =========================================================================
 * Compile-Time Invariants
 * ========================================================================= */

// Token Order: Must match grammar.js `externals` definition exactly.
_Static_assert(NEWLINE == 0, "Token order must match grammar externals[0]");
_Static_assert(INDENT  == 1, "Token order must match grammar externals[1]");
_Static_assert(DEDENT  == 2, "Token order must match grammar externals[2]");
_Static_assert(DEDENT == INDENT + 1, "Token order must remain contiguous");

// Tree-sitter guarantees valid_symbols matches external_token_count, but
// does not pass the size to scan(). We statically assert our assumptions here.
_Static_assert(VALID_SYMBOLS_MIN_SIZE == 3, "Exactly 3 external tokens defined");

// System Type Assumptions for Serialization
_Static_assert(CHAR_BIT == 8,           "Serialization assumes 8-bit bytes");
_Static_assert(sizeof(uint16_t) == 2,   "Serialization assumes 16-bit uint16_t");
_Static_assert(sizeof(uint8_t)  == 1,   "Serialization assumes 8-bit uint8_t");
_Static_assert(UINT16_MAX == 65535,     "Serialization assumes 16-bit uint16_t range");
_Static_assert(UINT8_MAX  == 255,       "Serialization assumes 8-bit uint8_t range");

// Scanner Limits
_Static_assert(MAX_INDENT_COLUMN < UINT16_MAX,    "Max indent must fit in uint16_t");
_Static_assert(MAX_PENDING_NEWLINES < UINT16_MAX, "Max pending newlines must fit in uint16_t");
_Static_assert(MAX_INDENT_DEPTH <= UINT8_MAX,     "Max indent depth must fit in serialization size field");

// Serialization Buffer Layout Layout
enum {
  SERIALIZED_STACK_ENTRY_BYTES = 2, // uint16_t per indent level
  SERIALIZED_SIZE_FIELD_BYTES  = 1, // uint8_t for stack size
  SCANNER_HEADER_BYTES         = 1 + 2 + 2 + SERIALIZED_SIZE_FIELD_BYTES, // flags + newlines + current_indent + size
};

_Static_assert(SCANNER_HEADER_BYTES == 6, "Header size must match serialization format");
_Static_assert(
  TREE_SITTER_SERIALIZATION_BUFFER_SIZE >= SCANNER_HEADER_BYTES + SERIALIZED_STACK_ENTRY_BYTES,
  "Serialization buffer too small for base indent stack"
);
_Static_assert(
  MAX_INDENT_DEPTH * SERIALIZED_STACK_ENTRY_BYTES <= TREE_SITTER_SERIALIZATION_BUFFER_SIZE - SCANNER_HEADER_BYTES,
  "Max indent depth must fit in serialization buffer"
);

/* =========================================================================
 * Tree-Sitter Interface Contracts & Assumptions
 * =========================================================================
 *
 * Payload Lifecycle:
 * - `create()` is called exactly once before any other function.
 * - The returned payload is passed unchanged to subsequent functions.
 * - `destroy()` is called at most once.
 *
 * Valid Symbols Array (`valid_symbols`):
 * - Evaluated safely up to index [2] (DEDENT) based on the grammar contract.
 * - Each element is a boolean indicating if the parser accepts that token right now.
 *
 * TSLexer API:
 * - `lookahead`:   Current character as int32_t.
 * - `advance()`:   Moves to the next character. Pass `true` to skip (e.g., whitespace).
 * - `mark_end()`:  Marks the end of the recognized token.
 * - `eof()`:       Checks if the end of the input stream is reached.
 * - `get_column()`: Returns the current column (handles tabs/spaces authoritatively).
 * ========================================================================= */

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

/* =========================================================================
 * Scanner State & Memory Management
 * ========================================================================= */

typedef struct {
  uint32_t magic; // Runtime validation signature
  Array(uint16_t) indents;
  bool at_line_start;
  bool indent_scanned;
  uint16_t current_indent;
  uint16_t pending_newlines;
} Scanner;

// Enforces structural integrity of the indentation stack
static inline void check_indent_invariants(const Scanner *s) {
  assert(s != NULL);
  assert(s->indents.size > 0);         // Must contain at least the base level
  assert(s->indents.contents != NULL);
  assert(s->indents.contents[0] == 0); // Base level is always column 0

  // Indent levels must be strictly monotonically increasing
  for (uint32_t i = 1; i < s->indents.size; i++) {
    assert(s->indents.contents[i] > s->indents.contents[i - 1]);
  }
}

void *tree_sitter_kippy_external_scanner_create(void) {
  Scanner *s = (Scanner *)ts_calloc(1, sizeof(Scanner));
  if (!s) return NULL;

  s->magic = SCANNER_MAGIC;
  array_init(&s->indents);

  // Initialize with base indentation level (0)
  uint16_t base = 0;
  array_push(&s->indents, base);

  if (s->indents.size != 1) {
    array_delete(&s->indents);
    ts_free(s);
    return NULL;
  }

  s->at_line_start = true;
  s->indent_scanned = false;
  s->current_indent = 0;
  s->pending_newlines = 0;

  check_indent_invariants(s);
  return s;
}

void tree_sitter_kippy_external_scanner_destroy(void *payload) {
  if (!payload) return;

  Scanner *s = (Scanner *)payload;
  assert(s->magic == SCANNER_MAGIC);

  array_delete(&s->indents);
  s->magic = 0; // Poison the struct to catch use-after-free
  ts_free(s);
}

/* =========================================================================
 * State Serialization & Deserialization
 * ========================================================================= */

unsigned tree_sitter_kippy_external_scanner_serialize(void *payload, char *buffer) {
  if (!payload || !buffer) return 0;

  Scanner *s = (Scanner *)payload;
  assert(s->magic == SCANNER_MAGIC);

  unsigned pos = 0;

  // Pack boolean flags
  uint8_t flags = 0;
  if (s->at_line_start)  flags |= 0x01;
  if (s->indent_scanned) flags |= 0x02;
  buffer[pos++] = (char)flags;

  // Serialize scalars (little-endian)
  buffer[pos++] = (char)(s->pending_newlines & 0xFF);
  buffer[pos++] = (char)((s->pending_newlines >> 8) & 0xFF);

  buffer[pos++] = (char)(s->current_indent & 0xFF);
  buffer[pos++] = (char)((s->current_indent >> 8) & 0xFF);

  // Serialize stack
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
  if (!payload) return;

  Scanner *s = (Scanner *)payload;
  assert(s->magic == SCANNER_MAGIC);

  // Reset to default state
  array_clear(&s->indents);
  s->at_line_start = true;
  s->indent_scanned = false;
  s->current_indent = 0;
  s->pending_newlines = 0;

  if (length > 0) {
    unsigned pos = 0;

    // Unpack boolean flags
    uint8_t flags = (uint8_t)buffer[pos++];
    s->at_line_start  = (flags & 0x01) != 0;
    s->indent_scanned = (flags & 0x02) != 0;

    // Unpack scalars
    if (pos + 2 <= length) {
      s->pending_newlines = (uint16_t)(uint8_t)buffer[pos] | ((uint16_t)(uint8_t)buffer[pos + 1] << 8);
      pos += 2;
    }

    if (pos + 2 <= length) {
      s->current_indent = (uint16_t)(uint8_t)buffer[pos] | ((uint16_t)(uint8_t)buffer[pos + 1] << 8);
      pos += 2;
    }

    // Restore base indent
    if (s->indents.size == 0) {
      uint16_t base = 0;
      array_push(&s->indents, base);
      if (s->indents.size != 1) {
        array_clear(&s->indents); // Allocation error; abort deserialization
      }
    }

    // Restore indent stack, ensuring monotonicity
    if (pos < length && s->indents.size == 1) {
      uint8_t stack_size = (uint8_t)buffer[pos++];

      for (uint8_t i = 0; i < stack_size && pos + 2 <= length; i++) {
        uint16_t indent = (uint16_t)(uint8_t)buffer[pos] | ((uint16_t)(uint8_t)buffer[pos + 1] << 8);
        pos += 2;

        uint16_t prev_indent = *array_back(&s->indents);

        if (indent <= prev_indent) {
          DEBUG_LOG("[DESERIALIZE] Non-monotonic indent rejected: %u <= %u\n", indent, prev_indent);
          array_clear(&s->indents);
          uint16_t base = 0;
          array_push(&s->indents, base);
          break;
        }

        uint32_t size_before = s->indents.size;
        array_push(&s->indents, indent);

        if (s->indents.size != size_before + 1) {
          DEBUG_LOG("[DESERIALIZE] Array push failed at indent level %u\n", indent);
          array_clear(&s->indents);
          uint16_t base = 0;
          array_push(&s->indents, base);
          break;
        }
      }
    }
  }

  // Fallback to base level if stack restoration failed entirely
  if (s->indents.size == 0) {
    uint16_t base = 0;
    array_push(&s->indents, base);
  }

  check_indent_invariants(s);
}

/* =========================================================================
 * Scanning Logic Helpers
 * ========================================================================= */

static inline uint16_t count_indent(TSLexer *lexer) {
  while (is_hspace(lexer->lookahead)) {
    lexer->advance(lexer, true);
  }

  uint32_t col = lexer->get_column(lexer);
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
  check_indent_invariants(s);

  if (!valid_symbols[DEDENT]) return false;

  if (s->indents.size > 1 && s->current_indent < *array_back(&s->indents)) {
    array_pop(&s->indents);
    check_indent_invariants(s);
    lexer->result_symbol = DEDENT;
    lexer->mark_end(lexer);
    return true;
  }

  return false;
}

static inline bool emit_indent(Scanner *s, TSLexer *lexer, const bool *valid_symbols) {
  check_indent_invariants(s);

  if (!valid_symbols[INDENT]) return false;

  if (s->current_indent > *array_back(&s->indents)) {
    // Prevent exceeding serialization capacity
    if (s->indents.size > MAX_INDENT_DEPTH) {
      return false;
    }

    uint32_t size_before = s->indents.size;
    array_push(&s->indents, s->current_indent);

    if (s->indents.size != size_before + 1) {
      return false; // Allocation failed
    }

    check_indent_invariants(s);
    lexer->result_symbol = INDENT;
    lexer->mark_end(lexer);
    return true;
  }

  return false;
}

/* =========================================================================
 * Main Scanner Entry Point
 * ========================================================================= */

bool tree_sitter_kippy_external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
  if (!payload || !lexer || !valid_symbols) return false;

  Scanner *s = (Scanner *)payload;
  assert(s->magic == SCANNER_MAGIC);

  DEBUG_LOG("[SCAN] at_line_start=%d indent_scanned=%d lookahead='%c'(0x%x) valid[INDENT]=%d valid[DEDENT]=%d\n",
    s->at_line_start, s->indent_scanned,
    (lexer->lookahead >= 32 && lexer->lookahead < 127) ? lexer->lookahead : '?',
    lexer->lookahead,
    valid_symbols[INDENT], valid_symbols[DEDENT]);

  // ═════════════════════════════════════════════════════════════════════════
  // PHASE 1: EOF HANDLING
  // ═════════════════════════════════════════════════════════════════════════
  // Upon EOF:
  // 1. Flush any pending blank-line NEWLINEs.
  // 2. Emit DEDENT tokens to close all remaining open blocks.

  if (lexer->eof(lexer)) {
    DEBUG_LOG("[PHASE1] EOF: pending_newlines=%u indents.size=%d\n", s->pending_newlines, s->indents.size);

    if (s->pending_newlines > 0 && valid_symbols[NEWLINE]) {
      s->pending_newlines--;
      log_emit("EOF_PENDING_NEWLINE", s, lexer);
      lexer->result_symbol = NEWLINE;
      return true;
    }

    s->current_indent = 0;
    if (s->indents.size > 1 && valid_symbols[DEDENT]) {
      return emit_dedent(s, lexer, valid_symbols);
    }

    return false; // All operations complete
  }

  // ═════════════════════════════════════════════════════════════════════════
  // PHASE 2: LINE-START LAYOUT HANDLING
  // ═════════════════════════════════════════════════════════════════════════

  bool can_do_layout = valid_symbols[INDENT] || valid_symbols[DEDENT];
  DEBUG_LOG("[PHASE2] at_line_start=%d can_do_layout=%d\n", s->at_line_start, can_do_layout);

  if (s->at_line_start && can_do_layout) {

    if (!s->indent_scanned) {
      while (true) {
        // CRITICAL: Check for blank lines BEFORE consuming indentation characters.
        // Consuming characters and returning false violates the scanner contract.
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

        s->current_indent = count_indent(lexer);
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
  // NOTE: Do NOT consume spaces here. If spaces are consumed and a newline
  // is not found, the scanner contract is violated.

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
