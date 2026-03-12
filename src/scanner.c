#include "tree_sitter/parser.h"
#include "tree_sitter/alloc.h"
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

// ---------------------------------------------------------------------------------------
// Constants & Types
// ---------------------------------------------------------------------------------------

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

#define MAX_INDENT_DEPTH 255

typedef struct {
    uint16_t indents[MAX_INDENT_DEPTH + 1]; // +1 for the base indent (0)
    uint16_t indent_count;
    ScanPhase phase;
    uint16_t current_line_indent;
} Scanner;

// ---------------------------------------------------------------------------------------
// Lexer Helpers
// ---------------------------------------------------------------------------------------

static inline void advance(TSLexer *lexer) { lexer->advance(lexer, false); }
static inline void skip(TSLexer *lexer)    { lexer->advance(lexer, true); }

static inline bool is_newline(int32_t c) { return c == '\n' || c == '\r'; }
static inline bool is_hspace(int32_t c)  { return c == ' '  || c == '\t'; }

// ---------------------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------------------

void *tree_sitter_kippy_external_scanner_create(void) {
    Scanner *s = (Scanner *)ts_calloc(1, sizeof(Scanner));
    s->indents[0] = 0; // Base indent is always 0
    s->indent_count = 1;
    s->phase = PHASE_BOL_UNSCANNED;
    return s;
}

void tree_sitter_kippy_external_scanner_destroy(void *payload) {
    if (payload) ts_free(payload);
}

// ---------------------------------------------------------------------------------------
// Serialization (Saving & Restoring State)
// ---------------------------------------------------------------------------------------

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

    if (length == 0) return;

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

// ---------------------------------------------------------------------------------------
// Main Scanner Logic
// ---------------------------------------------------------------------------------------

bool tree_sitter_kippy_external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
    Scanner *s = (Scanner *)payload;

    // 1. Handle EOF (Emit remaining DEDENTs)
    if (lexer->eof(lexer)) {
        if (valid_symbols[DEDENT] && s->indent_count > 1) {
            s->indent_count--;
            lexer->result_symbol = DEDENT;
            return true;
        }
        return false;
    }

    // 2. Handle Newlines
    if (valid_symbols[NEWLINE] && is_newline(lexer->lookahead)) {
        if (lexer->lookahead == '\r') advance(lexer);
        if (lexer->lookahead == '\n') advance(lexer);

        lexer->mark_end(lexer);
        s->phase = PHASE_BOL_UNSCANNED;
        lexer->result_symbol = NEWLINE;
        return true;
    }

    // 3. Measure indentation at the start of a new line
    if (s->phase == PHASE_BOL_UNSCANNED) {
        uint16_t column = 0;

        while (is_hspace(lexer->lookahead)) {
            skip(lexer); // Skip spaces so they don't become part of a token
            column = lexer->get_column(lexer);
        }

        // If the line is empty (just whitespace then newline/EOF), ignore its indentation
        if (is_newline(lexer->lookahead) || lexer->eof(lexer)) {
            return false;
        }

        s->current_line_indent = column;
        s->phase = PHASE_BOL_SCANNED;
    }

    // 4. Emit INDENT or DEDENT tokens
    if (s->phase == PHASE_BOL_SCANNED) {
        uint16_t previous_indent = s->indents[s->indent_count - 1];

        if (valid_symbols[INDENT] && s->current_line_indent > previous_indent) {
            if (s->indent_count <= MAX_INDENT_DEPTH) {
                s->indents[s->indent_count++] = s->current_line_indent;
            }
            lexer->result_symbol = INDENT;
            return true;
        }

        if (valid_symbols[DEDENT] && s->current_line_indent < previous_indent) {
            s->indent_count--;
            lexer->result_symbol = DEDENT;
            return true; // Return immediately; if we need multiple dedents, Tree-sitter will call us again
        }

        // If indentation hasn't changed, proceed to read standard tokens
        s->phase = PHASE_MIDLINE;
    }

    return false;
}
