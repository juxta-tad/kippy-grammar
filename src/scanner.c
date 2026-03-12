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
  BASE_INDENT_LEVEL       = 0,
  BASE_INDENT_STACK_SIZE  = 1,
  MAX_INDENT_DEPTH        = 255,
  INDENT_STACK_CAPACITY   = BASE_INDENT_STACK_SIZE + MAX_INDENT_DEPTH,
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

// The stack always contains the base indent. MAX_INDENT_DEPTH refers to
// additional indent levels above the base.
_Static_assert(
  MAX_INDENT_DEPTH + BASE_INDENT_STACK_SIZE <= UINT8_MAX + BASE_INDENT_STACK_SIZE,
  "MAX_INDENT_DEPTH must represent indents above the base level"
);

// safe_push_indent assumes exactly one base indent level
_Static_assert(
  BASE_INDENT_STACK_SIZE == 1,
  "safe_push_indent assumes exactly one base indent level"
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

static inline void format_lookahead(int32_t lookahead, char *buf) {
  switch (lookahead) {
    case '\n': strcpy(buf, "\\n"); break;
    case '\r': strcpy(buf, "\\r"); break;
    case '\t': strcpy(buf, "\\t"); break;
    case 0:    strcpy(buf, "EOF"); break;
    default:
      if (lookahead >= PRINTABLE_ASCII_MIN && lookahead <= PRINTABLE_ASCII_MAX) {
        buf[0] = (char)lookahead;
        buf[1] = '\0';
      } else {
        strcpy(buf, ".");
      }
      break;
  }
}

// =============================================================================
// Scanner State
// =============================================================================
typedef enum {
  SCAN_MIDLINE,
  SCAN_BOL_UNSCANNED,
  SCAN_BOL_SCANNED,
} ScanPhase;

static inline const char *scan_phase_name(ScanPhase phase) {
  switch (phase) {
    case SCAN_MIDLINE:       return "MIDLINE";
    case SCAN_BOL_UNSCANNED: return "BOL_UNSCANNED";
    case SCAN_BOL_SCANNED:   return "BOL_SCANNED";
    default:                 return "UNKNOWN";
  }
}

typedef struct {
  uint16_t data[INDENT_STACK_CAPACITY];
  uint16_t size;  // Always at least BASE_INDENT_STACK_SIZE (base indent present)
} IndentStack;

typedef struct {
  uint32_t magic;
  IndentStack indents;
  ScanPhase phase;
  uint16_t line_indent;
  uint16_t queued_dedents;
  uint32_t emitted_indents;
  uint32_t emitted_dedents;
} Scanner;

static inline void check_indent_invariants(const Scanner *s) {
  assert(s != NULL);
  assert(s->indents.size >= BASE_INDENT_STACK_SIZE);
  assert(s->indents.size <= INDENT_STACK_CAPACITY);
  assert(s->indents.data[BASE_INDENT_LEVEL] == BASE_INDENT_LEVEL);

  for (uint32_t i = BASE_INDENT_STACK_SIZE; i < s->indents.size; i++) {
    assert(s->indents.data[i] > s->indents.data[i - 1]);
  }
}

static inline uint16_t top_indent(const Scanner *s) {
  assert(s->indents.size >= BASE_INDENT_STACK_SIZE);
  return s->indents.data[s->indents.size - 1];
}

static inline bool safe_push_indent(Scanner *s, uint16_t indent) {
  if (s->indents.size >= INDENT_STACK_CAPACITY) return false;

  s->indents.data[s->indents.size++] = indent;

  assert(s->indents.size <= INDENT_STACK_CAPACITY);
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
  s->indents.data[0] = BASE_INDENT_LEVEL;
  s->indents.size = BASE_INDENT_STACK_SIZE;

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
    DEBUG_LOG("[DESTROY]     | WARN  | Unbalanced INDENT/DEDENT (%u emitted vs %u dedented)\n",
      s->emitted_indents, s->emitted_dedents);
  }

  s->magic = 0;
  ts_free(s);
}

// =============================================================================
// State Serialization & Deserialization (Kept Exactly As Is)
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
  uint8_t real_depth = (uint8_t)(s->indents.size - BASE_INDENT_STACK_SIZE);
  buffer[pos++] = (char)real_depth;

  for (uint32_t i = BASE_INDENT_STACK_SIZE; i < s->indents.size; i++) {
    uint16_t indent = s->indents.data[i];
    buffer[pos++] = (char)(indent & MASK_LOWER_8_BITS);
    buffer[pos++] = (char)((indent >> SHIFT_8_BITS) & MASK_LOWER_8_BITS);
  }
  return pos;
}

unsigned tree_sitter_kippy_external_scanner_serialize(void *payload, char *buffer) {
  if (!payload || !buffer) return 0;
  Scanner *s = (Scanner *)payload;
  unsigned pos = 0;
  pos = serialize_scalars(s, buffer, pos);
  pos = serialize_indents(s, buffer, pos);
  return pos;
}

static inline bool restore_base_indent(Scanner *s) {
  if (s->indents.size == 0) {
    s->indents.data[0] = BASE_INDENT_LEVEL;
    s->indents.size = BASE_INDENT_STACK_SIZE;
  }
  return true;
}

void tree_sitter_kippy_external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {
  if (!payload) return;
  Scanner *s = (Scanner *)payload;

  s->indents.size = 0;
  s->phase = SCAN_BOL_UNSCANNED;
  s->line_indent = 0;
  s->queued_dedents = 0;

  if (length > 0) {
    unsigned pos = 0;
    uint8_t flags = (uint8_t)buffer[pos++];
    s->phase = decode_phase_flags(flags);

    if (pos + UINT16_BYTES <= length) {
      s->line_indent = (uint16_t)(uint8_t)buffer[pos] | ((uint16_t)(uint8_t)buffer[pos + 1] << SHIFT_8_BITS);
      pos += UINT16_BYTES;
    }

    if (!restore_base_indent(s)) return;

    if (pos < length) {
      uint8_t stack_size = (uint8_t)buffer[pos++];
      for (uint8_t i = 0; i < stack_size && pos + UINT16_BYTES <= length; i++) {
        uint16_t indent = (uint16_t)(uint8_t)buffer[pos] | ((uint16_t)(uint8_t)buffer[pos + 1] << SHIFT_8_BITS);
        pos += UINT16_BYTES;
        safe_push_indent(s, indent);
      }
    }
  }

  restore_base_indent(s);
  check_indent_invariants(s);
}

// =============================================================================
// Scanner Pipeline (Builder Pattern for the Happy Path)
// =============================================================================
// This acts as a fluent context pipeline. Each step automatically handles its
// own business logic and gracefully skips if a token has already been matched.
// You do not need to understand C pointers to read the pipeline sequence.

typedef struct {
  Scanner *s;
  TSLexer *lexer;
  const bool *valid_symbols;

  bool is_finished;    // Set to true to stop progressing down the pipeline
  bool token_emitted;  // Set to true if we successfully matched a token to return
} ScanPipeline;

static inline ScanPipeline start_pipeline(void *payload, TSLexer *lexer, const bool *valid_symbols) {
  ScanPipeline p = {
    .s = (Scanner *)payload,
    .lexer = lexer,
    .valid_symbols = valid_symbols,
    .is_finished = false,
    .token_emitted = false
  };

  assert(p.s->magic == SCANNER_MAGIC);

  char la_str[4];
  format_lookahead(lexer->lookahead, la_str);
  DEBUG_LOG("[SCAN]        | INFO  | Phase: %-13s | Lookahead: '%s' (0x%02X) | Valid: [IND:%d DED:%d NL:%d]\n",
    scan_phase_name(p.s->phase), la_str, (uint32_t)lexer->lookahead,
    valid_symbols[INDENT], valid_symbols[DEDENT], valid_symbols[NEWLINE]);

  return p;
}

static inline bool try_emit_dedent(ScanPipeline *p) {
  check_indent_invariants(p->s);
  if (!p->valid_symbols[DEDENT]) return false;

  if (p->s->indents.size > BASE_INDENT_STACK_SIZE && p->s->line_indent < top_indent(p->s)) {
    array_pop(&p->s->indents);
    p->s->emitted_dedents++;
    p->lexer->result_symbol = DEDENT;
    p->lexer->mark_end(p->lexer);
    return true;
  }
  return false;
}

static inline bool try_emit_indent(ScanPipeline *p) {
  check_indent_invariants(p->s);
  if (!p->valid_symbols[INDENT] || p->s->line_indent <= top_indent(p->s)) return false;

  if (safe_push_indent(p->s, p->s->line_indent)) {
    p->s->emitted_indents++;
    p->lexer->result_symbol = INDENT;
    p->lexer->mark_end(p->lexer);
    return true;
  }
  return false;
}

static inline void match_eof_dedents(ScanPipeline *p) {
  if (p->is_finished) return;

  if (p->lexer->eof(p->lexer)) {
    p->s->line_indent = 0;
    enter_bol_scanned(p->s);

    if (try_emit_dedent(p)) {
      DEBUG_LOG("[EMIT]        | TOKEN | EOF_DEDENT\n");
      p->token_emitted = true;
    } else {
      assert(p->s->indents.size == BASE_INDENT_STACK_SIZE || !p->valid_symbols[DEDENT]);
    }
    p->is_finished = true;
  }
}

static inline void match_indent_or_dedent(ScanPipeline *p) {
  if (p->is_finished) return;

  bool can_do_layout = p->valid_symbols[INDENT] || p->valid_symbols[DEDENT];
  DEBUG_LOG("[LAYOUT]      | INFO  | Phase: %-13s | can_do_layout: %s\n",
    scan_phase_name(p->s->phase), can_do_layout ? "true" : "false");

  if (p->s->phase == SCAN_MIDLINE || !can_do_layout) return;

  // We only care about Indent/Dedent if we are reading a true line (not blank)
  if (p->lexer->eof(p->lexer) || is_newline(p->lexer->lookahead)) return;

  if (p->s->phase == SCAN_BOL_UNSCANNED) {
    uint16_t col_indent = 0;
    while (is_hspace(p->lexer->lookahead)) {
      p->lexer->advance(p->lexer, true);
      uint32_t col = p->lexer->get_column(p->lexer);
      col_indent = (col > MAX_INDENT_COLUMN) ? MAX_INDENT_COLUMN : (uint16_t)col;
    }
    // If the line ended up being blank, we exit early and let newlines match
    if (p->lexer->eof(p->lexer) || is_newline(p->lexer->lookahead)) return;

    p->s->line_indent = col_indent;
    enter_bol_scanned(p->s);
  }

  if (try_emit_dedent(p)) {
    DEBUG_LOG("[EMIT]        | TOKEN | DEDENT\n");
    p->token_emitted = true;
    p->is_finished = true;
    return;
  }

  if (try_emit_indent(p)) {
    DEBUG_LOG("[EMIT]        | TOKEN | INDENT (level: %u)\n", p->s->line_indent);
    enter_midline(p->s);
    p->token_emitted = true;
    p->is_finished = true;
    return;
  }

  // If no change in layout depth, smoothly transition to scanning line contents
  enter_midline(p->s);
  DEBUG_LOG("[LAYOUT]      | INFO  | No layout token, transitioning to MIDLINE\n");
}

static inline void match_newlines(ScanPipeline *p) {
  if (p->is_finished) return;

  DEBUG_LOG("[NEWLINE]     | INFO  | Checking for NEWLINE\n");
  if (!p->valid_symbols[NEWLINE] || !is_newline(p->lexer->lookahead)) return;

  if (p->lexer->lookahead == '\r') p->lexer->advance(p->lexer, false);
  if (p->lexer->lookahead == '\n') p->lexer->advance(p->lexer, false);

  p->lexer->mark_end(p->lexer);
  enter_bol_unscanned(p->s);

  p->lexer->result_symbol = NEWLINE;
  DEBUG_LOG("[EMIT]        | TOKEN | NEWLINE\n");

  p->token_emitted = true;
  p->is_finished = true;
}

static inline bool finish_pipeline(ScanPipeline *p) {
  return p->token_emitted;
}

// =============================================================================
// Main Scanner Entry Point (The Happy Path)
// =============================================================================
// We use a "Pipeline" (or Builder) pattern here so the parsing flow reads like
// plain English. Each step checks if the token has been resolved, and if not,
// attempts to match its specific grammar rules.

bool tree_sitter_kippy_external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
  if (!payload || !lexer || !valid_symbols) return false;

  ScanPipeline pipeline = start_pipeline(payload, lexer, valid_symbols);

  match_eof_dedents(&pipeline);
  match_indent_or_dedent(&pipeline);
  match_newlines(&pipeline);

  return finish_pipeline(&pipeline);
}
