#!/usr/bin/env bash
# forge.gates.sh — Quality Gates for this project
# FORGE runs this after each story. Must exit 0 to mark story passing.
# Customize per project. Commit alongside your code.

set -euo pipefail

echo "[GATES] Running TypeScript typecheck..."
npx tsc --noEmit

echo "[GATES] Running tests..."
npm test

# Uncomment if Python backend is present:
# echo "[GATES] Running Python tests..."
# python -m pytest tests/ -v --tb=short

# Uncomment if linting is configured:
# echo "[GATES] Running linter..."
# npm run lint

echo "[GATES] All gates passed ✓"
exit 0
