//DO NOT EDIT FILE

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
  SCANNER_HEADER_BYTES         = 1 + 2 + 2 + SERIALIZED_SIZE_FIELD_BYTES, // flags + newlines + line_indent + size
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

// Scanner state machine: explicit enum replaces coupled booleans
typedef enum {
  SCAN_MIDLINE,         // In the middle of a line (after first non-indent content)
  SCAN_BOL_UNSCANNED,   // At line start, haven't scanned indentation yet
  SCAN_BOL_SCANNED,     // At line start, indentation already scanned
} ScanPhase;

typedef struct {
  uint32_t magic; // Runtime validation signature
  Array(uint16_t) indents;
  ScanPhase phase;
  uint16_t line_indent;
  uint16_t queued_newlines;
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

// ─────────────────────────────────────────────────────────────────────────
// INDENT STACK HELPERS
// ─────────────────────────────────────────────────────────────────────────

static inline uint16_t top_indent(const Scanner *s) {
  // Get the current indentation level at the top of the stack
  assert(s->indents.size > 0);
  return *array_back((Array(uint16_t) *)&s->indents);
}

static inline void reset_indent_stack(Scanner *s) {
  // Reset indent stack to just the base level (0)
  array_clear(&s->indents);
  uint16_t base = 0;
  array_push(&s->indents, base);
}

// ─────────────────────────────────────────────────────────────────────────
// PHASE TRANSITION HELPERS
// ─────────────────────────────────────────────────────────────────────────

static inline void enter_midline(Scanner *s) {
  s->phase = SCAN_MIDLINE;
}

static inline void enter_bol_unscanned(Scanner *s) {
  s->phase = SCAN_BOL_UNSCANNED;
}

static inline void enter_bol_scanned(Scanner *s) {
  s->phase = SCAN_BOL_SCANNED;
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

  enter_bol_unscanned(s);
  s->line_indent = 0;
  s->queued_newlines = 0;

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

// Encode ScanPhase into a flags byte: bit 0 = at_line_start, bit 1 = indent_scanned
static inline uint8_t encode_phase_flags(ScanPhase phase) {
  uint8_t flags = 0;
  if (phase != SCAN_MIDLINE)    flags |= 0x01;  // at_line_start
  if (phase == SCAN_BOL_SCANNED) flags |= 0x02;  // indent_scanned
  return flags;
}

// Decode a flags byte back into ScanPhase
static inline ScanPhase decode_phase_flags(uint8_t flags) {
  bool at_line_start = (flags & 0x01) != 0;
  bool indent_scanned = (flags & 0x02) != 0;
  if (!at_line_start)         return SCAN_MIDLINE;
  else if (!indent_scanned)   return SCAN_BOL_UNSCANNED;
  else                        return SCAN_BOL_SCANNED;
}

// Serialize phase, queued_newlines, and line_indent into buffer (little-endian)
// Returns number of bytes written
static inline unsigned serialize_scalars(Scanner *s, char *buffer, unsigned start_pos) {
  unsigned pos = start_pos;

  buffer[pos++] = (char)encode_phase_flags(s->phase);
  buffer[pos++] = (char)(s->queued_newlines & 0xFF);
  buffer[pos++] = (char)((s->queued_newlines >> 8) & 0xFF);
  buffer[pos++] = (char)(s->line_indent & 0xFF);
  buffer[pos++] = (char)((s->line_indent >> 8) & 0xFF);

  return pos;
}

// Serialize indent stack (excluding base level) into buffer
// Returns number of bytes written
static inline unsigned serialize_indents(Scanner *s, char *buffer, unsigned start_pos) {
  unsigned pos = start_pos;

  assert(s->indents.size <= MAX_INDENT_DEPTH);
  uint8_t real_depth = (uint8_t)(s->indents.size - 1);  // Count without base
  buffer[pos++] = (char)real_depth;

  for (uint32_t i = 1; i < s->indents.size; i++) {
    uint16_t indent = s->indents.contents[i];
    buffer[pos++] = (char)(indent & 0xFF);
    buffer[pos++] = (char)((indent >> 8) & 0xFF);
  }

  return pos;
}

// Deserialize scalars from buffer and set scanner state
// Returns new buffer position, or 0 on error
static inline unsigned deserialize_scalars(Scanner *s, const char *buffer, unsigned length, unsigned start_pos) {
  unsigned pos = start_pos;

  if (pos >= length) return pos;

  uint8_t flags = (uint8_t)buffer[pos++];
  s->phase = decode_phase_flags(flags);

  if (pos + 2 <= length) {
    s->queued_newlines = (uint16_t)(uint8_t)buffer[pos] | ((uint16_t)(uint8_t)buffer[pos + 1] << 8);
    pos += 2;
  }

  if (pos + 2 <= length) {
    s->line_indent = (uint16_t)(uint8_t)buffer[pos] | ((uint16_t)(uint8_t)buffer[pos + 1] << 8);
    pos += 2;
  }

  return pos;
}

// Restore base indent level in the indent stack
static inline bool restore_base_indent(Scanner *s) {
  if (s->indents.size == 0) {
    uint16_t base = 0;
    array_push(&s->indents, base);
    if (s->indents.size != 1) {
      array_clear(&s->indents); // Allocation error
      return false;
    }
  }
  return true;
}

// Restore indent stack from buffer with monotonicity validation
// Returns success status
static inline bool restore_indent_stack(Scanner *s, const char *buffer, unsigned length, unsigned start_pos) {
  unsigned pos = start_pos;

  if (pos >= length || s->indents.size != 1) {
    return true; // No stack data or already failed to restore base
  }

  uint8_t stack_size = (uint8_t)buffer[pos++];

  for (uint8_t i = 0; i < stack_size && pos + 2 <= length; i++) {
    uint16_t indent = (uint16_t)(uint8_t)buffer[pos] | ((uint16_t)(uint8_t)buffer[pos + 1] << 8);
    pos += 2;

    uint16_t prev_indent = top_indent(s);

    if (indent <= prev_indent) {
      DEBUG_LOG("[DESERIALIZE] Non-monotonic indent rejected: %u <= %u\n", indent, prev_indent);
      array_clear(&s->indents);
      restore_base_indent(s);
      return true;
    }

    uint32_t size_before = s->indents.size;
    array_push(&s->indents, indent);

    if (s->indents.size != size_before + 1) {
      DEBUG_LOG("[DESERIALIZE] Array push failed at indent level %u\n", indent);
      array_clear(&s->indents);
      restore_base_indent(s);
      return true;
    }
  }

  return true;
}

unsigned tree_sitter_kippy_external_scanner_serialize(void *payload, char *buffer) {
  if (!payload || !buffer) return 0;

  Scanner *s = (Scanner *)payload;
  assert(s->magic == SCANNER_MAGIC);

  unsigned pos = 0;
  pos = serialize_scalars(s, buffer, pos);
  pos = serialize_indents(s, buffer, pos);
  return pos;
}

void tree_sitter_kippy_external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {
  if (!payload) return;

  Scanner *s = (Scanner *)payload;
  assert(s->magic == SCANNER_MAGIC);

  // Reset to default state
  array_clear(&s->indents);
  s->phase = SCAN_BOL_UNSCANNED;
  s->line_indent = 0;
  s->queued_newlines = 0;

  if (length > 0) {
    unsigned pos = 0;

    // Deserialize phase, queued_newlines, and line_indent
    pos = deserialize_scalars(s, buffer, length, pos);

    // Restore base indent level
    if (!restore_base_indent(s)) {
      check_indent_invariants(s);
      return;
    }

    // Restore indent stack with validation
    restore_indent_stack(s, buffer, length, pos);
  }

  // Ensure valid state
  if (s->indents.size == 0) {
    uint16_t base = 0;
    array_push(&s->indents, base);
  }

  check_indent_invariants(s);
}

/* =========================================================================
 * Line-Start Computation and Application
 * ========================================================================= */

// Forward declarations for helpers used in compute_line_start_info
static inline bool is_blank_line(TSLexer *lexer);
static inline uint16_t count_indent(TSLexer *lexer);

// Result of computing line-start information (blank line skipping + indent measurement)
typedef struct {
  bool has_content_line;  // True if we found a non-blank line with content
  uint16_t indent;        // Indentation level of the content line (if has_content_line)
  uint16_t blank_count;   // Number of blank lines skipped
} LineStartInfo;

// Compute line-start information from lexer: skip blank lines and measure indentation
// Mutates lexer position but does NOT mutate scanner state
static inline LineStartInfo compute_line_start_info(TSLexer *lexer) {
  LineStartInfo info = {0};

  while (true) {
    if (lexer->eof(lexer)) {
      break;
    }
    if (!is_newline(lexer->lookahead)) {
      break;
    }

    if (lexer->lookahead == '\r') lexer->advance(lexer, true);
    if (lexer->lookahead == '\n') lexer->advance(lexer, true);
    info.blank_count++;
  }

  if (!lexer->eof(lexer) && !is_newline(lexer->lookahead)) {
    info.has_content_line = true;
    info.indent = count_indent(lexer);
  }

  return info;
}

// Apply computed line-start information to scanner state
// Updates queued_newlines and line_indent based on the computed info
static inline void apply_line_start_info(Scanner *s, LineStartInfo info) {
  uint16_t limit = MAX_PENDING_NEWLINES - s->queued_newlines;
  if (info.blank_count < limit) limit = info.blank_count;
  s->queued_newlines += limit;

  if (info.has_content_line)
    s->line_indent = info.indent;
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
    "[EMIT %s] lookahead='%c'(0x%x) phase=%d line_indent=%u top=%u size=%u pending_nl=%u\n",
    name,
    (lexer->lookahead >= 32 && lexer->lookahead < 127) ? lexer->lookahead : '?',
    lexer->lookahead,
    s->phase,
    s->line_indent,
    s->indents.size ? top_indent(s) : 0,
    s->indents.size,
    s->queued_newlines
  );
}

static inline bool emit_dedent(Scanner *s, TSLexer *lexer, const bool *valid_symbols) {
  check_indent_invariants(s);

  if (!valid_symbols[DEDENT]) return false;

  if (s->indents.size > 1 && s->line_indent < top_indent(s)) {
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

  if (!valid_symbols[INDENT] ||
      s->line_indent <= top_indent(s) ||
      s->indents.size >= MAX_INDENT_DEPTH)
    return false;

  uint32_t n = s->indents.size;
  array_push(&s->indents, s->line_indent);
  if (s->indents.size != n + 1)
    return false;

  check_indent_invariants(s);
  lexer->result_symbol = INDENT;
  lexer->mark_end(lexer);
  return true;
}

static inline bool scan_line_start_layout(Scanner *s, TSLexer *lexer, const bool *valid_symbols) {
  bool can_do_layout = valid_symbols[INDENT] || valid_symbols[DEDENT];
  DEBUG_LOG("[PHASE2] phase=%d can_do_layout=%d\n", s->phase, can_do_layout);

  if (s->phase == SCAN_MIDLINE || !can_do_layout) {
    return false;
  }

  // Measure current line: skip blank lines and determine indentation
  if (s->phase == SCAN_BOL_UNSCANNED) {
    LineStartInfo info = compute_line_start_info(lexer);
    apply_line_start_info(s, info);
    enter_bol_scanned(s);
  }

  // Try to emit DEDENT
  if (emit_dedent(s, lexer, valid_symbols)) {
    log_emit("DEDENT", s, lexer);
    return true;
  }

  // Try to emit queued NEWLINE
  if (s->queued_newlines > 0 && valid_symbols[NEWLINE]) {
    s->queued_newlines--;
    log_emit("PENDING_NEWLINE", s, lexer);
    lexer->result_symbol = NEWLINE;
    return true;
  }

  // Try to emit INDENT
  if (emit_indent(s, lexer, valid_symbols)) {
    log_emit("INDENT", s, lexer);
    enter_midline(s);
    return true;
  }

  enter_midline(s);
  DEBUG_LOG("[PHASE2] exiting, transitioning to SCAN_MIDLINE\n");
  return false;
}

/* =========================================================================
 * Main Scanner Entry Point
 * ========================================================================= */

bool tree_sitter_kippy_external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
  if (!payload || !lexer || !valid_symbols) return false;

  Scanner *s = payload;
  assert(s->magic == SCANNER_MAGIC);

  DEBUG_LOG("[SCAN] phase=%d lookahead='%c'(0x%x) valid[INDENT]=%d valid[DEDENT]=%d\n",
    s->phase,
    (lexer->lookahead >= 32 && lexer->lookahead < 127) ? lexer->lookahead : '?',
    lexer->lookahead,
    valid_symbols[INDENT], valid_symbols[DEDENT]);

  if (lexer->eof(lexer)) {
    DEBUG_LOG("[EOF] queued_newlines=%u indents.size=%d\n", s->queued_newlines, s->indents.size);

    if (s->queued_newlines > 0 && valid_symbols[NEWLINE]) {
      s->queued_newlines--;
      log_emit("EOF_PENDING_NEWLINE", s, lexer);
      lexer->result_symbol = NEWLINE;
      return true;
    }

    return s->indents.size > 1 &&
           s->line_indent < top_indent(s) &&
           valid_symbols[DEDENT] &&
           emit_dedent(s, lexer, valid_symbols);
  }

  if (scan_line_start_layout(s, lexer, valid_symbols))
    return true;

  DEBUG_LOG("[PHASE3] checking for NEWLINE\n");
  if (!valid_symbols[NEWLINE] || !is_newline(lexer->lookahead))
    return false;

  if (lexer->lookahead == '\r') lexer->advance(lexer, false);
  if (lexer->lookahead == '\n') lexer->advance(lexer, false);

  lexer->mark_end(lexer);
  enter_bol_unscanned(s);
  lexer->result_symbol = NEWLINE;
  log_emit("NEWLINE", s, lexer);
  return true;
}
