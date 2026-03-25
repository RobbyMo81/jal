# JAL / Project Apex — Agent Institutional Memory

## Workspace Layout
- FORGE runtime: `/home/spoq/jal` (forge.sh, forge-memory-client.ts, etc.)
- Apex app source: `/home/spoq/jal/src/apex/`
- Shared types: `src/apex/types/index.ts`
- External PRD markdown: `/home/spoq/t7shield/Documents/forge/mnt/user-data`

## Phase Scope — READ THIS BEFORE IMPLEMENTING

**JAL-001 through JAL-008 are Phase 1 (MVP backend/runtime only.**

**DO NOT implement** Canvas UI, Slack plugin, Telegram plugin, or any frontend in Phase 1 stories.
These are explicitly Phase 2+:
- Canvas UX (real-time dashboard, terminal mirror, approval surfaces)
- Slack and Telegram collaboration plugins (§14 of PRD)
- Remote approval flows via bot commands or signed action links

For stories that mention Canvas output (e.g., "streams incrementally to Canvas"), implement the
**data layer and streaming logic only**. Emit structured events/callbacks that a future Canvas
can consume. Do not build the UI.

## Conventions (add entries here as stories complete)

## [JAL-001] — 2026-03-24
### Pattern Discovered
- `ShellEngine` in `src/apex/shell/ShellEngine.ts` is the single spawn point for all shell commands.
  Never call `child_process.spawn` directly — always use `ShellEngine.exec()`.
- `ShellEngine.resolveShell(shell, command)` maps ShellType → `{bin, args}` for bash/zsh/pwsh.
- `getActiveExecutions()` returns a `ReadonlyMap` of live PIDs + outputRefs for JAL-007 crash recovery.
  This map is populated immediately after spawn and cleared on process close.
### Gotcha
- Injection check (`INJECTION_RE`) blocks `;`, backtick, `$()`, `${}`, `\n` but **allows** `|` and `>`.
  Pipes and redirects are intentional. Semicolons and command substitution are not.
- The 2-second SIGKILL escalation timer in AbortSignal cancellation keeps Jest open after tests.
  Use `--forceExit` if needed in CI. Benign in production.
- `ExecOptions.timeout_ms` defaults to `DEFAULT_TIMEOUT_MS = 900_000` (15 min). Policy layer passes
  a different value to extend per-command.
### Files Modified
- `src/apex/shell/ShellEngine.ts` (new)
- `tests/shell/ShellEngine.test.ts` (new)
