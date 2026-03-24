#!/bin/bash
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tree-sitter generate
tree-sitter build --wasm
tree-sitter playground