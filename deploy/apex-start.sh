#!/usr/bin/env bash
# deploy/apex-start.sh — Apex daemon launcher
# Wrapper needed because systemd does not source ~/.nvm/nvm.sh.
# This script loads nvm, resolves the correct node/ts-node, then execs the agent.

set -euo pipefail

# Load nvm if available
export NVM_DIR="${HOME}/.nvm"
if [ -s "${NVM_DIR}/nvm.sh" ]; then
  # shellcheck disable=SC1091
  source "${NVM_DIR}/nvm.sh" --no-use
  nvm use default >/dev/null 2>&1 || true
fi

# Resolve ts-node from project-local node_modules
TS_NODE="${HOME}/jal/node_modules/.bin/ts-node"

if [ ! -x "${TS_NODE}" ]; then
  echo "ERROR: ts-node not found at ${TS_NODE}. Run 'npm install' in /home/spoq/jal first." >&2
  exit 1
fi

cd "${HOME}/jal"

exec "${TS_NODE}" \
  --project tsconfig.json \
  src/apex/main.ts
