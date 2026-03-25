#!/usr/bin/env bash
# forge.gates.sh — JAL/Apex quality gates
# Runs after every agent iteration. Must exit 0 for a story to be marked passing.

set -euo pipefail

echo "[GATES] Running JAL/Apex quality gates..."

echo "[GATES] 1/2 — TypeScript typecheck..."
npm run typecheck

echo "[GATES] 2/2 — Tests..."
npm test

echo "[GATES] All gates passed."
exit 0
