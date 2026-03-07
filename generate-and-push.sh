#!/bin/bash

# Script to regenerate Tree-sitter parser and push to GitHub
# Usage: ./generate-and-push.sh [commit message]
# Default commit message: "Regenerate parser"

set -e

COMMIT_MESSAGE="${1:-Regenerate parser}"

echo "🔨 Regenerating Tree-sitter parser..."
tree-sitter generate

echo "📝 Staging changes..."
git add -A

echo "💾 Committing with message: '$COMMIT_MESSAGE'"
git commit -m "$COMMIT_MESSAGE"

echo "🚀 Pushing to GitHub..."
git push

echo "✅ Done! Parser regenerated and pushed to GitHub."
