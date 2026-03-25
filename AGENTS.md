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

## [JAL-002] — 2026-03-25
### Pattern Discovered
- `DockerEngine` in `src/apex/docker/DockerEngine.ts` is the single spawn point for all Docker CLI calls.
  Never call `child_process.spawn('docker', ...)` directly — always use `DockerEngine`.
- `IPolicyFirewall` in `src/apex/policy/PolicyFirewall.ts` is the contract for the policy layer.
  `DockerEngine` accepts `IPolicyFirewall` via constructor injection — JAL-003's full firewall drops in
  without modifying DockerEngine.
- `DockerStubFirewall` enforces only JAL-002 safety gates (--privileged=Tier 3, prune/rm=Tier 2).
  It does NOT implement full tier logic — that is JAL-003's job.
- Streaming contract mirrors JAL-001: `onChunk(chunk, 'stdout'|'stderr')` callback + AbortSignal
  cancellation with SIGTERM + 2s SIGKILL escalation.
### Gotcha
- Container ID validation rejects IDs starting with `-` (e.g. `-v` injection attempts). Pattern:
  `/^[a-zA-Z0-9][a-zA-Z0-9_.\-]*$/`
- `jest.useFakeTimers()` in Jest 29 intercepts `setImmediate`, hanging tests that use
  `setImmediate(() => proc.emit('close', ...))` to resolve mock processes. Use real timers with
  `timeout_ms: 50` for timeout tests instead.
- `mockSpawn.mock.calls[0]` reads the first call globally across all tests unless `jest.clearAllMocks()`
  runs in a top-level `beforeEach`. Always add this guard or all call-index assertions will be wrong.
### Files Modified
- `src/apex/docker/DockerEngine.ts` (new)
- `src/apex/policy/PolicyFirewall.ts` (new)
- `tests/docker/DockerEngine.test.ts` (new)
