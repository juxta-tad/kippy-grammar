#include "tree_sitter/parser.h"
#include "tree_sitter/alloc.h"
#include <stdbool.h>
#include <stdint.h>
#include <string.h>
#include <limits.h>
#include <assert.h>

// =============================================================================
// Debugging Infrastructure
// =============================================================================

#if defined(__EMSCRIPTEN__) || defined(WASM_BUILD) || defined(__wasm__)
  #define IS_WASM 1
  #define DEBUG_LOG(...)
#else
  #define IS_WASM 0
  #include <stdio.h>
  #define DEBUG_LOG(...) fprintf(stderr, __VA_ARGS__)
#endif

// =============================================================================
// Constants & Types
// =============================================================================

#define SCANNER_MAGIC 0x4B495050 // "KIPP"
#define MAX_INDENT_DEPTH 255
#define MAX_INDENT_COLUMN 10000

enum TokenType {
    NEWLINE,
    INDENT,
    DEDENT,
};

typedef enum {
    PHASE_MIDLINE,
    PHASE_BOL_UNSCANNED,
    PHASE_BOL_SCANNED,
} ScanPhase;

typedef struct {
    uint32_t magic;
    uint16_t indents[MAX_INDENT_DEPTH + 1]; // +1 for the base indent (0)
    uint16_t indent_count;
    ScanPhase phase;
    uint16_t current_line_indent;

    // Debugging statistics
    uint32_t emitted_indents;
    uint32_t emitted_dedents;
} Scanner;

// Forward declaration of our runtime assert check (implemented at the bottom)
static void check_invariants(const Scanner *s);

// =============================================================================
// Lexer & Debug Helpers
// =============================================================================

static inline void advance(TSLexer *lexer) { lexer->advance(lexer, false); }
static inline void skip(TSLexer *lexer)    { lexer->advance(lexer, true); }

static inline bool is_newline(int32_t c) { return c == '\n' || c == '\r'; }
static inline bool is_hspace(int32_t c)  { return c == ' '  || c == '\t'; }

static inline const char *scan_phase_name(ScanPhase phase) {
    switch (phase) {
        case PHASE_MIDLINE:       return "MIDLINE";
        case PHASE_BOL_UNSCANNED: return "BOL_UNSCANNED";
        case PHASE_BOL_SCANNED:   return "BOL_SCANNED";
        default:                  return "UNKNOWN";
    }
}

static inline void format_lookahead(int32_t lookahead, char *buf) {
    switch (lookahead) {
        case '\n': strcpy(buf, "\\n"); break;
        case '\r': strcpy(buf, "\\r"); break;
        case '\t': strcpy(buf, "\\t"); break;
        case 0:    strcpy(buf, "EOF"); break;
        default:
            if (lookahead >= 32 && lookahead <= 126) {
                buf[0] = (char)lookahead; buf[1] = '\0';
            } else {
                strcpy(buf, ".");
            }
            break;
    }
}

// =============================================================================
// Lifecycle
// =============================================================================

void *tree_sitter_kippy_external_scanner_create(void) {
    Scanner *s = (Scanner *)ts_calloc(1, sizeof(Scanner));
    s->magic = SCANNER_MAGIC;
    s->indents[0] = 0; // Base indent is always 0
    s->indent_count = 1;
    s->phase = PHASE_BOL_UNSCANNED;

    check_invariants(s);
    return s;
}

void tree_sitter_kippy_external_scanner_destroy(void *payload) {
    if (!payload) return;
    Scanner *s = (Scanner *)payload;
    check_invariants(s);

    if (s->emitted_indents != s->emitted_dedents) {
        DEBUG_LOG("[DESTROY]     | WARN  | Unbalanced INDENT/DEDENT (%u emitted vs %u dedented)\n",
            s->emitted_indents, s->emitted_dedents);
    }

    s->magic = 0;
    ts_free(s);
}

// =============================================================================
// Serialization (Saving & Restoring State)
// =============================================================================

unsigned tree_sitter_kippy_external_scanner_serialize(void *payload, char *buffer) {
    Scanner *s = (Scanner *)payload;
    unsigned pos = 0;

    // 1. Save state scalars
    buffer[pos++] = (char)s->phase;
    buffer[pos++] = (char)(s->current_line_indent & 0xFF);
    buffer[pos++] = (char)((s->current_line_indent >> 8) & 0xFF);

    // 2. Save indent stack (skip base indent 0)
    buffer[pos++] = (char)(s->indent_count - 1);
    for (uint16_t i = 1; i < s->indent_count; i++) {
        buffer[pos++] = (char)(s->indents[i] & 0xFF);
        buffer[pos++] = (char)((s->indents[i] >> 8) & 0xFF);
    }

    return pos;
}

void tree_sitter_kippy_external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {
    Scanner *s = (Scanner *)payload;

    // Default state
    s->indent_count = 1;
    s->indents[0] = 0;
    s->phase = PHASE_BOL_UNSCANNED;
    s->current_line_indent = 0;

    if (length > 0) {
        unsigned pos = 0;

        // 1. Restore state scalars
        s->phase = (ScanPhase)buffer[pos++];
        s->current_line_indent = (uint8_t)buffer[pos++] | ((uint8_t)buffer[pos++] << 8);

        // 2. Restore indent stack
        uint8_t extra_indents = (uint8_t)buffer[pos++];
        for (uint8_t i = 0; i < extra_indents && pos < length; i++) {
            s->indents[s->indent_count++] = (uint8_t)buffer[pos++] | ((uint8_t)buffer[pos++] << 8);
        }
    }

    check_invariants(s);
}

// =============================================================================
// Main Scanner Logic
// =============================================================================

bool tree_sitter_kippy_external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
    Scanner *s = (Scanner *)payload;
    check_invariants(s);

    char la_str[4];
    format_lookahead(lexer->lookahead, la_str);
    DEBUG_LOG("[SCAN]        | INFO  | Phase: %-13s | Lookahead: '%s' (0x%02X) | Valid: [IND:%d DED:%d NL:%d]\n",
        scan_phase_name(s->phase), la_str, (uint32_t)lexer->lookahead,
        valid_symbols[INDENT], valid_symbols[DEDENT], valid_symbols[NEWLINE]);

    // 1. Handle EOF (Emit remaining DEDENTs)
    if (lexer->eof(lexer)) {
        s->phase = PHASE_BOL_SCANNED;
        s->current_line_indent = 0;

        if (valid_symbols[DEDENT] && s->indent_count > 1) {
            s->indent_count--;
            s->emitted_dedents++;
            lexer->result_symbol = DEDENT;
            DEBUG_LOG("[EMIT]        | TOKEN | EOF_DEDENT\n");
            return true;
        }
        return false;
    }

    // 2. Handle Newlines
    if (valid_symbols[NEWLINE] && is_newline(lexer->lookahead)) {
        DEBUG_LOG("[NEWLINE]     | INFO  | Checking for NEWLINE\n");
        if (lexer->lookahead == '\r') advance(lexer);
        if (lexer->lookahead == '\n') advance(lexer);

        lexer->mark_end(lexer);
        s->phase = PHASE_BOL_UNSCANNED;
        lexer->result_symbol = NEWLINE;
        DEBUG_LOG("[EMIT]        | TOKEN | NEWLINE\n");
        return true;
    }

    bool can_do_layout = valid_symbols[INDENT] || valid_symbols[DEDENT];
    if (s->phase == PHASE_MIDLINE || !can_do_layout) return false;

    // 3. Measure indentation at the start of a new line
    if (s->phase == PHASE_BOL_UNSCANNED) {
        uint16_t column = 0;

        while (is_hspace(lexer->lookahead)) {
            skip(lexer); // Skip spaces so they don't become part of a token
            column = lexer->get_column(lexer);
        }

        s->current_line_indent = (column > MAX_INDENT_COLUMN) ? MAX_INDENT_COLUMN : column;
        s->phase = PHASE_BOL_SCANNED;

        // If the line is empty (just whitespace then newline/EOF), ignore its indentation
        if (is_newline(lexer->lookahead) || lexer->eof(lexer)) {
            return false;
        }
    }

    // 4. Emit INDENT or DEDENT tokens
    if (s->phase == PHASE_BOL_SCANNED) {
        uint16_t previous_indent = s->indents[s->indent_count - 1];

        if (valid_symbols[DEDENT] && s->current_line_indent < previous_indent) {
            s->indent_count--;
            s->emitted_dedents++;
            lexer->result_symbol = DEDENT;
            DEBUG_LOG("[EMIT]        | TOKEN | DEDENT\n");
            return true; // Return immediately; if we need multiple dedents, Tree-sitter will call us again
        }

        if (valid_symbols[INDENT] && s->current_line_indent > previous_indent) {
            if (s->indent_count <= MAX_INDENT_DEPTH) {
                s->indents[s->indent_count++] = s->current_line_indent;
            }
            s->emitted_indents++;
            lexer->result_symbol = INDENT;
            DEBUG_LOG("[EMIT]        | TOKEN | INDENT (level: %u)\n", s->current_line_indent);
            return true;
        }

        // If indentation hasn't changed, proceed to read standard tokens
        DEBUG_LOG("[LAYOUT]      | INFO  | No layout token, transitioning to MIDLINE\n");
        s->phase = PHASE_MIDLINE;
    }

    return false;
}


// =============================================================================
// Assertions & Compile-Time Invariants
// =============================================================================

static void check_invariants(const Scanner *s) {
    assert(s != NULL);
    assert(s->magic == SCANNER_MAGIC);
    assert(s->indent_count >= 1);
    assert(s->indent_count <= MAX_INDENT_DEPTH + 1);
    assert(s->indents[0] == 0); // Base level must always be 0

    // Ensure indent stack is strictly monotonically increasing
    for (uint16_t i = 1; i < s->indent_count; i++) {
        assert(s->indents[i] > s->indents[i - 1]);
    }
}

// Ensure our external grammar definition matches our token enum mapping exactly
_Static_assert(NEWLINE == 0, "Token order must match grammar externals[0]");
_Static_assert(INDENT  == 1, "Token order must match grammar externals[1]");
_Static_assert(DEDENT  == 2, "Token order must match grammar externals[2]");

// Ensure safe bit shifting and masking limits
_Static_assert(CHAR_BIT == 8,         "Serialization assumes 8-bit bytes");
_Static_assert(sizeof(uint16_t) == 2, "Serialization assumes 16-bit uint16_t");
_Static_assert(UINT16_MAX == 65535,   "Serialization assumes 16-bit uint16_t range");
_Static_assert(UINT8_MAX  == 255,     "Serialization assumes 8-bit uint8_t range");

// Ensure Tree-sitter allocated buffer size is large enough to save state
_Static_assert(
    TREE_SITTER_SERIALIZATION_BUFFER_SIZE >= 4 + (MAX_INDENT_DEPTH * 2),
    "Tree-sitter serialization buffer is too small for max indent depth"
);
