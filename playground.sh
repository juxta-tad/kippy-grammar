#!/bin/bash
set -e

CRATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RED='\033[0;31m'; GREEN='\033[0;32m'; BLUE='\033[0;34m'; YELLOW='\033[1;33m'; NC='\033[0m'

header() { echo -e "${BLUE}========================================\nTree-Sitter Kippy Parser Playground\n========================================${NC}\n"; }
help() {
    cat << 'EOF'
Commands: play | test | grammar | help | exit
Examples:
  ./playground.sh play    # Start playground with hot reload
  ./playground.sh test    # Run tests
EOF
}

regen() {
    echo -e "${YELLOW}[$(date '+%H:%M:%S')] Regenerating parser...${NC}"
    tree-sitter generate 2>&1 | tail -5
    tree-sitter build --wasm 2>&1 | tail -1
    echo -e "${GREEN}[$(date '+%H:%M:%S')] Ready! Refresh browser${NC}"
}

play() {
    command -v tree-sitter &>/dev/null || { echo -e "${RED}tree-sitter CLI not found${NC}"; return 1; }
    echo -e "${GREEN}Building WASM parser...${NC}"
    cd "$CRATE_DIR"
    tree-sitter generate 2>&1 | tail -5
    tree-sitter build --wasm 2>&1 || { echo -e "${RED}WASM build failed${NC}"; return 1; }

    tree-sitter playground &
    PLAY_PID=$!

    if command -v fswatch &>/dev/null; then
        fswatch -r "$(pwd)" --include '\.js$' --exclude 'node_modules' | while read -r f; do
            [[ "$f" == *"grammar.js" ]] && regen
        done &
    else
        echo -e "${YELLOW}(fswatch not found, using polling)${NC}"
        last=$(stat -f %m "$CRATE_DIR/grammar.js" 2>/dev/null || stat -c %Y "$CRATE_DIR/grammar.js")
        while true; do
            sleep 2
            cur=$(stat -f %m "$CRATE_DIR/grammar.js" 2>/dev/null || stat -c %Y "$CRATE_DIR/grammar.js")
            [[ "$cur" != "$last" ]] && { last=$cur; regen; }
        done &
    fi
    WATCH_PID=$!
    trap "kill $PLAY_PID $WATCH_PID 2>/dev/null; exit" EXIT INT TERM
    wait $PLAY_PID
}

test() { 
    cd "$CRATE_DIR"
    echo -e "${GREEN}Running tree-sitter tests...${NC}"
    tree-sitter generate 2>&1 | tail -3
    tree-sitter test 2>&1
}
grammar() { echo -e "${GREEN}Grammar:${NC} $CRATE_DIR/grammar.js"; }

loop() {
    header
    while true; do
        read -p "kippy-playground> " cmd arg
        case "$cmd" in
            play) play ;;
            test) test ;;
            grammar) grammar ;;
            help) help ;;
            exit|quit) exit 0 ;;
            "") continue ;;
            *) echo -e "${RED}Unknown: $cmd${NC}" ;;
        esac
        echo
    done
}

main() {
    command -v tree-sitter &>/dev/null || { echo -e "${RED}Error: tree-sitter CLI not installed${NC}\n"; exit 1; }
    case "${1:-}" in
        help) header; help ;;
        play) play ;;
        test) test ;;
        grammar) grammar ;;
        "") loop ;;
        *) echo "Usage: $0 [play|test|grammar|help]"; exit 1 ;;
    esac
}

main "$@"
