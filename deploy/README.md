# Apex Deployment — JAL-021

Runs Apex as a persistent systemd user service. The heartbeat, memory, and Canvas server run continuously — Apex is always on.

## Prerequisites

```bash
# 1. Configure environment
cp .env.example .env
# Edit .env — set OLLAMA_BASE_URL, APEX_DEFAULT_MODEL, APEX_WORKSPACE_ROOTS

# 2. Install dependencies
npm install

# 3. Build Canvas UI
cd src/apex/canvas/ui && npm install && npm run build && cd -

# 4. (Optional) Install libsecret for OS keyring credential storage
sudo apt install libsecret-tools
```

## Install & Start

```bash
bash deploy/install.sh
```

## Daily Commands

```bash
journalctl --user -u apex -f          # live logs
systemctl --user status apex          # status + last 10 lines
systemctl --user restart apex         # restart after config change
systemctl --user stop apex            # stop
```

## Canvas Dashboard

Once running, open: `http://localhost:7474/canvas?token=<session_token>`

The session token is printed to the log on startup:

```bash
journalctl --user -u apex | grep "session_token"
```

## Uninstall

```bash
bash deploy/install.sh --stop
rm ~/.config/systemd/user/apex.service
systemctl --user daemon-reload
```

## Keychain Backends

The startup log shows which keychain is in use:

| Backend | Persistence | Security | Requirement |
|---|---|---|---|
| `secret-tool` | ✓ Survives restart | OS keyring (best) | `libsecret-tools` |
| `file` | ✓ Survives restart | chmod 600 JSON | none |
| `memory` | ✗ Lost on exit | none | fallback only |

To upgrade to OS keyring: `sudo apt install libsecret-tools` then restart.
