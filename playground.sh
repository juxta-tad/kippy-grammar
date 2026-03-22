#!/bin/bash
set -e

CRATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RED='\033[0;31m'; GREEN='\033[0;32m'; BLUE='\033[0;34m'; YELLOW='\033[1;33m'; NC='\033[0m'

header() { echo -e "${BLUE}========================================\nTree-Sitter Kippy Parser Playground\n========================================${NC}\n"; }
help() {
    cat << 'EOF'
Commands: test | grammar | help | exit
Examples:
  ./playground.sh test    # Run tests
EOF
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
        test) test ;;
        grammar) grammar ;;
        "") loop ;;
        *) echo "Usage: $0 [test|grammar|help]"; exit 1 ;;
    esac
}

main "$@"
