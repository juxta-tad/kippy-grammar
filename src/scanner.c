//DO NOT EDIT FILE

// =============================================================================
// Includes & Macros
// =============================================================================
#include "tree_sitter/parser.h"
#include "tree_sitter/array.h"
#include <assert.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>

// Disable standard I/O debug logging for WebAssembly
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

// =============================================================================
// Constants & Enums
// =============================================================================
enum ScannerConfig {
  SCANNER_MAGIC        = 0x4B495050, // "KIPP"
  MAX_INDENT_COLUMN    = 10000,
  MAX_PENDING_NEWLINES = 50000,
  MAX_INDENT_DEPTH     = 255,
};

enum TokenType {
  NEWLINE,
  INDENT,
  DEDENT,
};

enum ValidityConfig {
  VALID_SYMBOLS_MIN_SIZE = DEDENT + 1,
};

enum IndentConstants {
  BASE_INDENT_LEVEL      = 0,
  BASE_INDENT_STACK_SIZE = 1,
};

enum SerializationConstants {
  SHIFT_8_BITS      = 8,
  MASK_LOWER_8_BITS = 0xFF,
  UINT16_BYTES      = 2,
};

enum PhaseFlags {
  PHASE_FLAG_AT_LINE_START  = 0x01,
  PHASE_FLAG_INDENT_SCANNED = 0x02,
};

enum ASCIIPrintables {
  PRINTABLE_ASCII_MIN = 32,
  PRINTABLE_ASCII_MAX = 126,
};

// Serialization Buffer Layout
enum BufferLayout {
  SERIALIZED_STACK_ENTRY_BYTES = 2,
  SERIALIZED_SIZE_FIELD_BYTES  = 1,
  SCANNER_HEADER_BYTES         = 1 + 2 + SERIALIZED_SIZE_FIELD_BYTES,
};

// =============================================================================
// Compile-Time Invariants
// =============================================================================
_Static_assert(NEWLINE == 0, "Token order must match grammar externals[0]");
_Static_assert(INDENT  == 1, "Token order must match grammar externals[1]");
_Static_assert(DEDENT  == 2, "Token order must match grammar externals[2]");
_Static_assert(DEDENT == INDENT + 1, "Token order must remain contiguous");

_Static_assert(VALID_SYMBOLS_MIN_SIZE == 3, "Exactly 3 external tokens defined");

_Static_assert(CHAR_BIT == 8,           "Serialization assumes 8-bit bytes");
_Static_assert(sizeof(uint16_t) == 2,   "Serialization assumes 16-bit uint16_t");
_Static_assert(sizeof(uint8_t)  == 1,   "Serialization assumes 8-bit uint8_t");
_Static_assert(UINT16_MAX == 65535,     "Serialization assumes 16-bit uint16_t range");
_Static_assert(UINT8_MAX  == 255,       "Serialization assumes 8-bit uint8_t range");

_Static_assert(MAX_INDENT_COLUMN < UINT16_MAX,    "Max indent must fit in uint16_t");
_Static_assert(MAX_PENDING_NEWLINES < UINT16_MAX, "Max pending newlines must fit in uint16_t");
_Static_assert(MAX_INDENT_DEPTH <= UINT8_MAX,     "Max indent depth must fit in serialization size field");

_Static_assert(SCANNER_HEADER_BYTES == 4, "Header size must match serialization format");
_Static_assert(
  TREE_SITTER_SERIALIZATION_BUFFER_SIZE >= SCANNER_HEADER_BYTES + SERIALIZED_STACK_ENTRY_BYTES,
  "Serialization buffer too small for base indent stack"
);
_Static_assert(
  MAX_INDENT_DEPTH * SERIALIZED_STACK_ENTRY_BYTES <= TREE_SITTER_SERIALIZATION_BUFFER_SIZE - SCANNER_HEADER_BYTES,
  "Max indent depth must fit in serialization buffer"
);

// =============================================================================
// Character Set Utilities
// =============================================================================
static const TSCharacterRange NEWLINE_CHARS[] = {
  {'\n', '\n'},
  {'\r', '\r'},
};
#define NEWLINE_CHARS_COUNT (sizeof(NEWLINE_CHARS) / sizeof(NEWLINE_CHARS[0]))

static const TSCharacterRange HSPACE_CHARS[] = {
  {'\t', '\t'},
  {' ',  ' '},
};
#define HSPACE_CHARS_COUNT (sizeof(HSPACE_CHARS) / sizeof(HSPACE_CHARS[0]))

static inline bool is_newline(int32_t c) {
  return set_contains(NEWLINE_CHARS, NEWLINE_CHARS_COUNT, c);
}

static inline bool is_hspace(int32_t c) {
  return set_contains(HSPACE_CHARS, HSPACE_CHARS_COUNT, c);
}

// =============================================================================
// Scanner State
// =============================================================================
typedef enum {
  SCAN_MIDLINE,
  SCAN_BOL_UNSCANNED,
  SCAN_BOL_SCANNED,
} ScanPhase;

typedef struct {
  uint32_t magic;
  Array(uint16_t) indents;
  ScanPhase phase;
  uint16_t line_indent;
  uint16_t queued_dedents;
  uint32_t emitted_indents;
  uint32_t emitted_dedents;
} Scanner;

static inline void check_indent_invariants(const Scanner *s) {
  assert(s != NULL);
  assert(s->indents.size >= BASE_INDENT_STACK_SIZE);
  assert(s->indents.contents != NULL);
  assert(s->indents.contents[BASE_INDENT_LEVEL] == BASE_INDENT_LEVEL);

  for (uint32_t i = BASE_INDENT_STACK_SIZE; i < s->indents.size; i++) {
    assert(s->indents.contents[i] > s->indents.contents[i - 1]);
  }
}

static inline uint16_t top_indent(const Scanner *s) {
  assert(s->indents.size >= BASE_INDENT_STACK_SIZE);
  return *array_back((Array(uint16_t) *)&s->indents);
}

static inline void reset_indent_stack(Scanner *s) {
  array_clear(&s->indents);
  uint16_t base = BASE_INDENT_LEVEL;
  array_push(&s->indents, base);
}

static inline bool safe_push_indent(Scanner *s, uint16_t indent) {
  if (s->indents.size > MAX_INDENT_DEPTH) {
    return false;
  }

  uint32_t n = s->indents.size;
  array_push(&s->indents, indent);

  if (s->indents.size != n + 1) {
    array_clear(&s->indents);
    return false;
  }

  return true;
}

static inline void enter_midline(Scanner *s)       { s->phase = SCAN_MIDLINE; }
static inline void enter_bol_unscanned(Scanner *s) { s->phase = SCAN_BOL_UNSCANNED; }
static inline void enter_bol_scanned(Scanner *s)   { s->phase = SCAN_BOL_SCANNED; }

// =============================================================================
// Initialization & Destruction
// =============================================================================
void *tree_sitter_kippy_external_scanner_create(void) {
  Scanner *s = (Scanner *)ts_calloc(1, sizeof(Scanner));
  if (!s) return NULL;

  s->magic = SCANNER_MAGIC;
  array_init(&s->indents);

  uint16_t base = BASE_INDENT_LEVEL;
  array_push(&s->indents, base);

  if (s->indents.size != BASE_INDENT_STACK_SIZE) {
    array_delete(&s->indents);
    ts_free(s);
    return NULL;
  }

  enter_bol_unscanned(s);
  s->line_indent = 0;
  s->queued_dedents = 0;
  s->emitted_indents = 0;
  s->emitted_dedents = 0;

  check_indent_invariants(s);
  return s;
}

void tree_sitter_kippy_external_scanner_destroy(void *payload) {
  if (!payload) return;

  Scanner *s = (Scanner *)payload;
  assert(s->magic == SCANNER_MAGIC);

  if (s->emitted_indents != s->emitted_dedents) {
    DEBUG_LOG("[DESTROY] Warning: unbalanced INDENT/DEDENT (%u vs %u)\n",
      s->emitted_indents, s->emitted_dedents);
  }

  if (s->indents.size != BASE_INDENT_STACK_SIZE) {
    DEBUG_LOG("[DESTROY] Warning: non-base indentation level at destroy (size=%u)\n",
      s->indents.size);
  }

  array_delete(&s->indents);
  s->magic = 0;
  ts_free(s);
}

// =============================================================================
// State Serialization & Deserialization
// =============================================================================
static inline uint8_t encode_phase_flags(ScanPhase phase) {
  uint8_t flags = 0;
  if (phase != SCAN_MIDLINE)     flags |= PHASE_FLAG_AT_LINE_START;
  if (phase == SCAN_BOL_SCANNED) flags |= PHASE_FLAG_INDENT_SCANNED;
  return flags;
}

static inline ScanPhase decode_phase_flags(uint8_t flags) {
  bool at_line_start  = (flags & PHASE_FLAG_AT_LINE_START) != 0;
  bool indent_scanned = (flags & PHASE_FLAG_INDENT_SCANNED) != 0;

  if (!at_line_start)       return SCAN_MIDLINE;
  else if (!indent_scanned) return SCAN_BOL_UNSCANNED;
  else                      return SCAN_BOL_SCANNED;
}

static inline unsigned serialize_scalars(Scanner *s, char *buffer, unsigned start_pos) {
  unsigned pos = start_pos;
  buffer[pos++] = (char)encode_phase_flags(s->phase);
  buffer[pos++] = (char)(s->line_indent & MASK_LOWER_8_BITS);
  buffer[pos++] = (char)((s->line_indent >> SHIFT_8_BITS) & MASK_LOWER_8_BITS);
  return pos;
}

static inline unsigned serialize_indents(Scanner *s, char *buffer, unsigned start_pos) {
  unsigned pos = start_pos;
  assert(s->indents.size <= MAX_INDENT_DEPTH);

  uint8_t real_depth = (uint8_t)(s->indents.size - BASE_INDENT_STACK_SIZE);
  buffer[pos++] = (char)real_depth;

  for (uint32_t i = BASE_INDENT_STACK_SIZE; i < s->indents.size; i++) {
    uint16_t indent = s->indents.contents[i];
    buffer[pos++] = (char)(indent & MASK_LOWER_8_BITS);
    buffer[pos++] = (char)((indent >> SHIFT_8_BITS) & MASK_LOWER_8_BITS);
  }

  return pos;
}

static inline unsigned deserialize_scalars(Scanner *s, const char *buffer, unsigned length, unsigned start_pos) {
  unsigned pos = start_pos;
  if (pos >= length) return pos;

  uint8_t flags = (uint8_t)buffer[pos++];
  s->phase = decode_phase_flags(flags);

  if (pos + UINT16_BYTES <= length) {
    s->line_indent = (uint16_t)(uint8_t)buffer[pos] | ((uint16_t)(uint8_t)buffer[pos + 1] << SHIFT_8_BITS);
    pos += UINT16_BYTES;
  }

  return pos;
}

static inline bool restore_base_indent(Scanner *s) {
  if (s->indents.size == 0) {
    uint16_t base = BASE_INDENT_LEVEL;
    array_push(&s->indents, base);
    if (s->indents.size != BASE_INDENT_STACK_SIZE) {
      array_clear(&s->indents);
      return false;
    }
  }
  return true;
}

static inline bool restore_indent_stack(Scanner *s, const char *buffer, unsigned length, unsigned start_pos) {
  unsigned pos = start_pos;

  if (pos >= length || s->indents.size != BASE_INDENT_STACK_SIZE) {
    return true;
  }

  uint8_t stack_size = (uint8_t)buffer[pos++];

  for (uint8_t i = 0; i < stack_size && pos + UINT16_BYTES <= length; i++) {
    uint16_t indent = (uint16_t)(uint8_t)buffer[pos] | ((uint16_t)(uint8_t)buffer[pos + 1] << SHIFT_8_BITS);
    pos += UINT16_BYTES;

    uint16_t prev_indent = top_indent(s);

    if (indent <= prev_indent) {
      DEBUG_LOG("[DESERIALIZE] Non-monotonic indent rejected: %u <= %u\n", indent, prev_indent);
      array_clear(&s->indents);
      restore_base_indent(s);
      return false;
    }

    if (!safe_push_indent(s, indent)) {
      DEBUG_LOG("[DESERIALIZE] Array push failed at indent level %u\n", indent);
      restore_base_indent(s);
      return false;
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

  array_clear(&s->indents);
  s->phase = SCAN_BOL_UNSCANNED;
  s->line_indent = 0;
  s->queued_dedents = 0;

  if (length > 0) {
    unsigned pos = 0;
    pos = deserialize_scalars(s, buffer, length, pos);

    if (!restore_base_indent(s)) {
      check_indent_invariants(s);
      return;
    }

    restore_indent_stack(s, buffer, length, pos);
  }

  if (s->indents.size == 0) {
    uint16_t base = BASE_INDENT_LEVEL;
    array_push(&s->indents, base);
    if (s->indents.size != BASE_INDENT_STACK_SIZE) {
      DEBUG_LOG("[DESERIALIZE] Failed to restore base indent at end\n");
      return;
    }
  }

  check_indent_invariants(s);
}

// =============================================================================
// Line-Start Computation and Application
// =============================================================================
static inline bool scan_current_line_layout(TSLexer *lexer, uint16_t *indent_out) {
  uint16_t indent = 0;

  while (is_hspace(lexer->lookahead)) {
    lexer->advance(lexer, true);
    uint32_t col = lexer->get_column(lexer);
    indent = (col > MAX_INDENT_COLUMN) ? MAX_INDENT_COLUMN : (uint16_t)col;
  }

  if (lexer->eof(lexer) || is_newline(lexer->lookahead)) {
    return false;
  }

  *indent_out = indent;
  return true;
}

static inline bool emit_dedent(Scanner *s, TSLexer *lexer, const bool *valid_symbols) {
  check_indent_invariants(s);

  if (!valid_symbols[DEDENT]) return false;

  if (s->indents.size > BASE_INDENT_STACK_SIZE && s->line_indent < top_indent(s)) {
    array_pop(&s->indents);
    check_indent_invariants(s);

    assert(s->indents.size >= BASE_INDENT_STACK_SIZE && "DEDENT below base level");
    assert(s->indents.size == BASE_INDENT_STACK_SIZE || top_indent(s) <= s->line_indent || top_indent(s) > s->line_indent);

    s->emitted_dedents++;
    lexer->result_symbol = DEDENT;
    lexer->mark_end(lexer);
    return true;
  }

  return false;
}

static inline bool emit_indent(Scanner *s, TSLexer *lexer, const bool *valid_symbols) {
  check_indent_invariants(s);

  if (!valid_symbols[INDENT] || s->line_indent <= top_indent(s)) {
    return false;
  }

  if (!safe_push_indent(s, s->line_indent)) {
    return false;
  }

  check_indent_invariants(s);
  assert(top_indent(s) == s->line_indent && "INDENT pushed wrong indent value");

  s->emitted_indents++;
  lexer->result_symbol = INDENT;
  lexer->mark_end(lexer);
  return true;
}

static inline bool is_bol_position(TSLexer *lexer) {
  return lexer->eof(lexer) || is_newline(lexer->lookahead) || is_hspace(lexer->lookahead);
}

static inline bool scan_line_start_layout(Scanner *s, TSLexer *lexer, const bool *valid_symbols) {
  bool can_do_layout = valid_symbols[INDENT] || valid_symbols[DEDENT];
  DEBUG_LOG("[PHASE2] phase=%d can_do_layout=%d\n", s->phase, can_do_layout);

  if (s->phase == SCAN_MIDLINE || !can_do_layout) {
    return false;
  }

  // Only process layout for content lines
  if (lexer->eof(lexer) || is_newline(lexer->lookahead)) {
    return false;
  }

  if (s->phase == SCAN_BOL_UNSCANNED) {
    uint16_t indent = 0;
    if (!scan_current_line_layout(lexer, &indent)) {
      return false;
    }
    s->line_indent = indent;
    enter_bol_scanned(s);
  }

  if (emit_dedent(s, lexer, valid_symbols)) {
    DEBUG_LOG("[emit] DEDENT\n");
    return true;
  }

  if (emit_indent(s, lexer, valid_symbols)) {
    DEBUG_LOG("[emit] INDENT\n");
    enter_midline(s);
    return true;
  }

  enter_midline(s);
  DEBUG_LOG("[PHASE2] no layout token, transitioning to MIDLINE\n");
  return false;
}

// =============================================================================
// Main Scanner Entry Point
// =============================================================================
bool tree_sitter_kippy_external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
  if (!payload || !lexer || !valid_symbols) return false;

  Scanner *s = payload;
  assert(s->magic == SCANNER_MAGIC);

  DEBUG_LOG("[SCAN] phase=%d lookahead='%c'(0x%x) valid[INDENT]=%d valid[DEDENT]=%d\n",
    s->phase,
    (lexer->lookahead >= PRINTABLE_ASCII_MIN && lexer->lookahead <= PRINTABLE_ASCII_MAX) ? lexer->lookahead : '?',
    lexer->lookahead,
    valid_symbols[INDENT], valid_symbols[DEDENT]);

  if (lexer->eof(lexer)) {
    s->line_indent = 0;
    enter_bol_scanned(s);

    if (emit_dedent(s, lexer, valid_symbols)) {
      DEBUG_LOG("[emit] EOF_DEDENT\n");
      return true;
    }

    assert(s->indents.size == BASE_INDENT_STACK_SIZE || !valid_symbols[DEDENT]);
    return false;
  }

  if (scan_line_start_layout(s, lexer, valid_symbols)) {
    return true;
  }

  DEBUG_LOG("[PHASE3] checking for NEWLINE\n");
  if (!valid_symbols[NEWLINE] || !is_newline(lexer->lookahead)) {
    return false;
  }

  if (lexer->lookahead == '\r') lexer->advance(lexer, false);
  if (lexer->lookahead == '\n') lexer->advance(lexer, false);

  lexer->mark_end(lexer);
  enter_bol_unscanned(s);
  lexer->result_symbol = NEWLINE;
  DEBUG_LOG("[emit] NEWLINE\n");
  return true;
}
