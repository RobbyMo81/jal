#!/usr/bin/env bash
# deploy/install.sh — Install Apex as a persistent user-level systemd daemon
#
# Usage:
#   bash deploy/install.sh          # install and start
#   bash deploy/install.sh --stop   # stop and disable
#   bash deploy/install.sh --status # show service status and recent logs
#
# No root required. Installs to ~/.config/systemd/user/

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "${SCRIPT_DIR}")"
SERVICE_NAME="apex"
UNIT_FILE="${SCRIPT_DIR}/apex.user.service"
START_SCRIPT="${SCRIPT_DIR}/apex-start.sh"
INSTALL_DIR="${HOME}/.config/systemd/user"

# ── Pre-flight ─────────────────────────────────────────────────────────────────

if [ ! -f "${REPO_DIR}/.env" ]; then
  echo "ERROR: .env not found at ${REPO_DIR}/.env"
  echo "       Copy .env.example to .env and configure it first."
  exit 1
fi

if [ ! -f "${REPO_DIR}/node_modules/.bin/ts-node" ]; then
  echo "ERROR: node_modules not found. Run 'npm install' in ${REPO_DIR} first."
  exit 1
fi

# ── Stop / status branches ─────────────────────────────────────────────────────

if [ "${1:-}" = "--stop" ]; then
  echo "Stopping and disabling apex service..."
  systemctl --user stop "${SERVICE_NAME}" 2>/dev/null || true
  systemctl --user disable "${SERVICE_NAME}" 2>/dev/null || true
  echo "Done. Service stopped."
  exit 0
fi

if [ "${1:-}" = "--status" ]; then
  systemctl --user status "${SERVICE_NAME}" --no-pager || true
  echo ""
  echo "Recent logs:"
  journalctl --user -u "${SERVICE_NAME}" -n 50 --no-pager
  exit 0
fi

# ── Install ────────────────────────────────────────────────────────────────────

echo "Installing Apex systemd user service..."

# Make start script executable
chmod +x "${START_SCRIPT}"

# Install unit file
mkdir -p "${INSTALL_DIR}"
cp "${UNIT_FILE}" "${INSTALL_DIR}/${SERVICE_NAME}.service"

# Patch WorkingDirectory and EnvironmentFile to absolute paths
sed -i "s|WorkingDirectory=/home/spoq/jal|WorkingDirectory=${REPO_DIR}|g" \
  "${INSTALL_DIR}/${SERVICE_NAME}.service"
sed -i "s|EnvironmentFile=/home/spoq/jal/.env|EnvironmentFile=${REPO_DIR}/.env|g" \
  "${INSTALL_DIR}/${SERVICE_NAME}.service"
sed -i "s|ExecStart=/home/spoq/jal/deploy/apex-start.sh|ExecStart=${START_SCRIPT}|g" \
  "${INSTALL_DIR}/${SERVICE_NAME}.service"
sed -i "s|Documentation=file:///home/spoq/jal/FORGE.md|Documentation=file://${REPO_DIR}/FORGE.md|g" \
  "${INSTALL_DIR}/${SERVICE_NAME}.service"

# Enable lingering so the user service runs without an active login session
loginctl enable-linger "${USER}" 2>/dev/null || \
  echo "Warning: could not enable linger. Service may not run without an active session."

# Reload systemd and enable
systemctl --user daemon-reload
systemctl --user enable "${SERVICE_NAME}"
systemctl --user restart "${SERVICE_NAME}"

echo ""
echo "Apex daemon installed and started."
echo ""
echo "Commands:"
echo "  journalctl --user -u apex -f          # follow logs"
echo "  systemctl --user status apex          # service status"
echo "  systemctl --user stop apex            # stop"
echo "  systemctl --user restart apex         # restart"
echo "  bash deploy/install.sh --stop         # disable and stop"
