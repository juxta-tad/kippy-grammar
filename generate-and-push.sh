#!/bin/bash

# Script to regenerate Tree-sitter parser and push to GitHub
# Usage: ./generate-and-push.sh [commit message]
# Default commit message: "Regenerate parser"

set -e

COMMIT_MESSAGE="${1:-Regenerate parser}"

# Change to the grammar directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

tree-sitter generate 2>&1 | grep -v "Warning:" || true

git add -A

git commit -m "$COMMIT_MESSAGE" --quiet

git push --quiet

echo "✅ Parser regenerated and pushed."
