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

typedef struct {
    uint32_t magic;
    uint16_t indents[MAX_INDENT_DEPTH + 1]; // +1 for the base indent (0)
    uint16_t indent_count;
    uint16_t pending_dedents;

    // Debugging statistics
    uint32_t emitted_indents;
    uint32_t emitted_dedents;
} Scanner;

// Forward declaration
static void check_invariants(const Scanner *s);

// =============================================================================
// Lexer & Debug Helpers
// =============================================================================

static inline void advance(TSLexer *lexer) { lexer->advance(lexer, false); }
static inline void skip(TSLexer *lexer)    { lexer->advance(lexer, true); }

static inline bool is_newline(int32_t c) { return c == '\n' || c == '\r'; }
static inline bool is_hspace(int32_t c)  { return c == ' '  || c == '\t'; }

static inline void format_lookahead(int32_t lookahead, char *buf) {
    switch (lookahead) {
        case '\n': strcpy(buf, "\\n"); break;
        case '\r': strcpy(buf, "\\r"); break;
        case '\t': strcpy(buf, "\\t"); break;
        case 0:    strcpy(buf, "EOF"); break;
        default:
            if (lookahead >= 32 && lookahead <= 126) {
                buf[0] = (char)lookahead;
                buf[1] = '\0';
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
    s->pending_dedents = 0;

    check_invariants(s);
    return s;
}

void tree_sitter_kippy_external_scanner_destroy(void *payload) {
    if (!payload) return;
    Scanner *s = (Scanner *)payload;
    check_invariants(s);

    uint16_t net_open_indents = (uint16_t)((s->indent_count - 1) + s->pending_dedents);
    if (net_open_indents > 0) {
        DEBUG_LOG(
            "[DESTROY]     | WARN  | Unclosed indentation (stack depth: %u, pending dedents: %u)\n",
            (unsigned)(s->indent_count - 1),
            (unsigned)s->pending_dedents
        );
    }

    s->magic = 0;
    ts_free(s);
}

// =============================================================================
// Serialization
// =============================================================================

unsigned tree_sitter_kippy_external_scanner_serialize(void *payload, char *buffer) {
    Scanner *s = (Scanner *)payload;
    unsigned pos = 0;

    buffer[pos++] = (char)(s->pending_dedents & 0xFF);
    buffer[pos++] = (char)((s->pending_dedents >> 8) & 0xFF);

    buffer[pos++] = (char)(s->indent_count - 1);
    for (uint16_t i = 1; i < s->indent_count; i++) {
        buffer[pos++] = (char)(s->indents[i] & 0xFF);
        buffer[pos++] = (char)((s->indents[i] >> 8) & 0xFF);
    }

    return pos;
}

void tree_sitter_kippy_external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {
    Scanner *s = (Scanner *)payload;

    s->indent_count = 1;
    s->indents[0] = 0;
    s->pending_dedents = 0;

    if (length > 0) {
        unsigned pos = 0;

        if (pos + 1 < length) {
            uint8_t low = (uint8_t)buffer[pos++];
            uint8_t high = (uint8_t)buffer[pos++];
            s->pending_dedents = (uint16_t)(low | (high << 8));
        }

        if (pos < length) {
            uint8_t extra_indents = (uint8_t)buffer[pos++];
            for (uint8_t i = 0;
                 i < extra_indents && (pos + 1) < length && s->indent_count <= MAX_INDENT_DEPTH;
                 i++) {
                uint8_t low = (uint8_t)buffer[pos++];
                uint8_t high = (uint8_t)buffer[pos++];
                s->indents[s->indent_count++] = (uint16_t)(low | (high << 8));
            }
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

    char la_str[8];
    format_lookahead(lexer->lookahead, la_str);
    DEBUG_LOG(
        "[SCAN]        | INFO  | Lookahead: '%s' (0x%02X) | Col: %u | Valid: [IND:%d DED:%d NL:%d]\n",
        la_str,
        (unsigned)lexer->lookahead,
        (unsigned)lexer->get_column(lexer),
        valid_symbols[INDENT],
        valid_symbols[DEDENT],
        valid_symbols[NEWLINE]
    );

    // 1. Emit queued DEDENTs first.
    if (s->pending_dedents > 0 && valid_symbols[DEDENT]) {
        s->pending_dedents--;
        s->emitted_dedents++;
        lexer->result_symbol = DEDENT;
        DEBUG_LOG("[EMIT]        | TOKEN | PENDING DEDENT (%u remaining)\n",
                  (unsigned)s->pending_dedents);
        return true;
    }

    // 2. EOF: drain remaining indentation stack.
    if (lexer->eof(lexer)) {
        if (valid_symbols[DEDENT] && s->indent_count > 1) {
            s->indent_count--;
            s->emitted_dedents++;
            lexer->result_symbol = DEDENT;
            DEBUG_LOG("[EMIT]        | TOKEN | EOF_DEDENT\n");
            return true;
        }
        return false;
    }

    // 3. Only compute indentation at the start of a physical line.
    if (lexer->get_column(lexer) == 0) {
        while (is_hspace(lexer->lookahead)) {
            skip(lexer);
        }

        uint16_t indent = (uint16_t)lexer->get_column(lexer);
        if (indent > MAX_INDENT_COLUMN) {
            indent = MAX_INDENT_COLUMN;
        }

        // Blank line: emit NEWLINE, but do not touch indent stack.
        if (is_newline(lexer->lookahead)) {
            if (valid_symbols[NEWLINE]) {
                if (lexer->lookahead == '\r') advance(lexer);
                if (lexer->lookahead == '\n') advance(lexer);
                lexer->result_symbol = NEWLINE;
                DEBUG_LOG("[EMIT]        | TOKEN | BLANK_LINE_NEWLINE\n");
                return true;
            }
            return false;
        }

        uint16_t previous_indent = s->indents[s->indent_count - 1];

        if (valid_symbols[DEDENT] && indent < previous_indent) {
            uint16_t pop_count = 0;

            while (s->indent_count > 1 && s->indents[s->indent_count - 1] > indent) {
                s->indent_count--;
                pop_count++;
            }

            // Reject half-dedents: indentation must match a previous level exactly.
            if (s->indents[s->indent_count - 1] != indent) {
                DEBUG_LOG(
                    "[SCAN]        | WARN  | Invalid dedent target: got %u, nearest stack top %u\n",
                    (unsigned)indent,
                    (unsigned)s->indents[s->indent_count - 1]
                );
                return false;
            }

            if (pop_count > 0) {
                s->pending_dedents = (uint16_t)(pop_count - 1);
                s->emitted_dedents++;
                lexer->result_symbol = DEDENT;
                DEBUG_LOG("[EMIT]        | TOKEN | DEDENT (pending: %u)\n",
                          (unsigned)s->pending_dedents);
                return true;
            }
        }

        previous_indent = s->indents[s->indent_count - 1];

        if (valid_symbols[INDENT] && indent > previous_indent) {
            if (s->indent_count <= MAX_INDENT_DEPTH) {
                s->indents[s->indent_count++] = indent;
            }
            s->emitted_indents++;
            lexer->result_symbol = INDENT;
            DEBUG_LOG("[EMIT]        | TOKEN | INDENT (level: %u)\n",
                      (unsigned)indent);
            return true;
        }
    }

    // 4. Standard NEWLINE tokenization elsewhere.
    if (valid_symbols[NEWLINE] && is_newline(lexer->lookahead)) {
        if (lexer->lookahead == '\r') advance(lexer);
        if (lexer->lookahead == '\n') advance(lexer);
        lexer->result_symbol = NEWLINE;
        DEBUG_LOG("[EMIT]        | TOKEN | NEWLINE\n");
        return true;
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
    assert(s->indents[0] == 0);

    for (uint16_t i = 1; i < s->indent_count; i++) {
        assert(s->indents[i] > s->indents[i - 1]);
    }
}

_Static_assert(NEWLINE == 0, "Token order must match grammar externals[0]");
_Static_assert(INDENT  == 1, "Token order must match grammar externals[1]");
_Static_assert(DEDENT  == 2, "Token order must match grammar externals[2]");

_Static_assert(CHAR_BIT == 8,         "Serialization assumes 8-bit bytes");
_Static_assert(sizeof(uint16_t) == 2, "Serialization assumes 16-bit uint16_t");
_Static_assert(UINT16_MAX == 65535,   "Serialization assumes 16-bit uint16_t range");
_Static_assert(UINT8_MAX  == 255,     "Serialization assumes 8-bit uint8_t range");

_Static_assert(
    TREE_SITTER_SERIALIZATION_BUFFER_SIZE >= 3 + (MAX_INDENT_DEPTH * 2),
    "Tree-sitter serialization buffer is too small for max indent depth"
);
