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

## [JAL-003] — 2026-03-25
### Pattern Discovered
- Full tiered policy firewall is in `src/apex/policy/TieredFirewall.ts`.
  `TieredFirewall` implements `IPolicyFirewall` so it drops directly into `ShellEngine`
  and `DockerEngine` without any changes to those classes.
- Tier classification order is: Tier 3 check → package-install allowlist check → Tier 2
  check → Tier 1 default. This order matters — never reorder.
- `ApprovalService` tokens are single-use (removed from pending map on first resolve).
  `onApprovalRequired` callback is the ONLY mechanism to deliver the token to the
  operator. Callers must wire this up or Tier 2 actions hang forever.
- `AuditLog` is append-only JSONL at `~/.apex/audit/audit.log` with SHA-256 hash
  chaining. Every `classify()` call writes at least one entry *before* execution proceeds.
- `PackageAllowlist` file is at `~/.apex/policy/package-allowlist.json`. It caches in
  memory but invalidates on every write so re-instantiation is not required between reads.
### Gotcha
- `ShellEngine.exec()` had `IPolicyFirewall` wired in the constructor but the `classify()`
  call was missing from the exec path — added in JAL-003. If you see commands bypassing
  the firewall from the shell engine, this is the place to check.
- `AuditLog.ts` spread of `Omit<AuditEntry, ...>` triggers a TypeScript error when
  `AuditEntry` has an index signature (`[key: string]: unknown`). Fix with `as AuditEntry`
  cast — this is a known TS limitation, not a logic bug.
- Tier 3 has zero bypass paths by design. `onApprovalRequired` is never called for Tier 3.
  Do not add an override path.
- `ApprovalService` TTL timer is 5 minutes (`TOKEN_TTL_MS`). Tests that use fake timers
  must advance past this value or the promise will never resolve during the test run.
### Files Modified
- `src/apex/policy/TieredFirewall.ts` (new — full firewall implementation)
- `src/apex/policy/ApprovalService.ts` (new — single-use token lifecycle)
- `src/apex/policy/PackageAllowlist.ts` (new — versioned JSON allowlist with audit)
- `src/apex/policy/AuditLog.ts` (new — JSONL with SHA-256 hash chaining)
- `src/apex/shell/ShellEngine.ts` (modified — wired firewall.classify() into exec())
- `tests/policy/TieredFirewall.test.ts` (new — 84 tests covering all acceptance criteria)

## [JAL-004] — 2026-03-25
### Pattern Discovered
- `PolicyFileOps` wraps all file I/O. Every operation resolves symlinks (via `realpathSync`)
  before workspace boundary checks. For new files (not yet on disk), symlinks are resolved
  on the parent directory.
- `WorkspaceRootsConfig` is the authority for workspace roots. It caches the JSON file in
  memory after first load. Cache is invalidated on every write (add/remove).
- Shell profile detection is by **basename only** (`SHELL_PROFILE_NAMES` set) — a `.bashrc`
  anywhere on the filesystem triggers Tier 2, even inside a workspace root.
- System paths (`/etc/`, `/usr/`, `/bin/`, etc.) are caught by prefix match on the resolved
  absolute path before workspace membership is tested.
- Classification order for write/create: (1) shell profile name check → (2) system path
  prefix check → (3) workspace root membership → (4) Tier 1 default.
- `classify()` is a dry-run method that issues a real Tier 2 approval request. Wire
  `onApprovalRequired` in tests or it will hang waiting for operator resolution.
### Gotcha
- Path traversal check inspects **raw input** (before `path.resolve()`). Any `..` segment
  in the raw string is rejected with a structured error and an audit log entry. This check
  must remain on the raw path — do not move it after `resolvePath()`.
- `chownSync` requires numeric UID/GID on Linux. `PolicyFileOps.chown()` takes `uid: number`
  and `gid: number` — do not pass strings. Tests should use `process.getuid!()` /
  `process.getgid!()` to get valid IDs without needing elevated privileges.
- `read` is unconditionally Tier 1. Reads are never gated, regardless of path.
- All delete operations are Tier 2 — there is no Tier 1 delete path.
### Files Modified
- `src/apex/fileops/PolicyFileOps.ts` (new — policy-bounded file I/O)
- `src/apex/fileops/WorkspaceRootsConfig.ts` (new — versioned workspace roots with audit)
- `src/apex/types/index.ts` (extended — FileOperationType, WorkspaceRootsFile, FileOpOptions, FileOpResult)
- `tests/fileops/PolicyFileOps.test.ts` (new — 63 tests covering all acceptance criteria)

## Auto-compiled from FORGE Discoveries — 2026-03-25

### PATTERNS
- **[JAL-001] ShellEngine wraps all shell spawning**: Never call child_process.spawn directly — always use ShellEngine.exec() which enforces sudo block and injection checks.
- **[JAL-001] Injection check allows pipes and redirects**: INJECTION_RE blocks ; backtick  ${} 
 but NOT | or >. Pipes and redirects are considered legitimate shell constructs. Semicolons and command substitution are blocked.
- **[JAL-002] DockerEngine uses IPolicyFirewall constructor injection — JAL-003 drops in without code changes**: DockerEngine accepts an optional IPolicyFirewall in its constructor. DockerStubFirewall is the default. When JAL-003 implements the real firewall, pass it to new DockerEngine(realFirewall). No changes to DockerEngine required.
- **[JAL-003] TieredFirewall classification order**: Order is Tier3 → allowlist check → Tier2 → Tier1 default. Never reorder.
- **[JAL-003] ApprovalService single-use tokens**: Tokens removed from pending map on first resolve — single-use by design. onApprovalRequired callback is the only delivery mechanism. If unset, Tier 2 hangs.
- **[JAL-004] PolicyFileOps classification order for write/create**: Order: (1) shell profile name check via SHELL_PROFILE_NAMES set → (2) system path prefix check → (3) workspace root membership → (4) Tier 1 default. Never reorder.

### GOTCHAS
- **[JAL-001] SIGKILL escalation timer lingers in Jest**: The 2-second SIGKILL escalation in onAbort() keeps Jest open after cancellation tests. Add --forceExit to test:coverage if needed. Benign in production.
- **[JAL-002] jest.useFakeTimers() in Jest 29 intercepts setImmediate — hangs spawn mock tests**: Using jest.useFakeTimers() when mock ChildProcess uses setImmediate to emit close events causes test hangs. Fix: use real timers with a very short timeout_ms (50ms) to test timeout logic instead of fake timers.
- **[JAL-002] mockSpawn.mock.calls[0] bleeds across describe blocks without clearAllMocks in beforeEach**: In Jest, mock call history persists across describe blocks in the same file. Always add beforeEach(() => jest.clearAllMocks()) at the top of the test file when checking mock.calls[0] in multiple describes.
- **[JAL-003] ShellEngine firewall was declared but not called**: ShellEngine.exec() had IPolicyFirewall in constructor but classify() was missing from exec path. Fixed in JAL-003 — always check firewall wiring when adding new engines.
- **[JAL-003] AuditLog spread + index signature TS error**: Omit<AuditEntry,...> spread triggers TS error when interface has [key:string]:unknown. Fix: cast with as AuditEntry.
- **[JAL-004] Path traversal check must run on raw input before path.resolve()**: The .. check in resolveSafe() runs on rawPath BEFORE resolve(). Do not move after resolution — resolve() collapses .. segments, defeating the check.
- **[JAL-004] classify() awaits real Tier 2 approval — wire onApprovalRequired**: PolicyFileOps.classify() calls ApprovalService.requestApproval() for Tier 2 ops. If onApprovalRequired is not wired, classify() hangs indefinitely.

### CONVENTIONS
- **[JAL-001] ExecOptions.timeout_ms is per-command**: Policy layer (JAL-003) passes timeout_ms in ExecOptions to extend beyond the 900s default. Default is always 900000ms unless overridden.
- **[JAL-003] Policy files location**: Package allowlist: ~/.apex/policy/package-allowlist.json. Audit log: ~/.apex/audit/audit.log. Both dirs created on first write.

### DEPENDENCYS
- **[JAL-001] JAL-007 reads getActiveExecutions()**: ShellEngine.getActiveExecutions() returns a ReadonlyMap of pid, command, startedAt, outputRef, cancelled. JAL-007 crash recovery depends on this surface being populated before exec() resolves.

## [JAL-005] — 2026-03-25
### Pattern Discovered
- `AuthManager` in `src/apex/auth/AuthManager.ts` is the single authority for session lifecycle.
  Inject `IKeychain` (OS-backed via `SecretToolKeychain`, test-double via `MemoryKeychain`).
  Provider isolation is enforced by keying sessions as `session:<provider>` — getToken('anthropic')
  physically cannot return an openai token.
- `ProviderGateway` in `src/apex/auth/ProviderGateway.ts` is the provider-agnostic inference entry point.
  Register adapters via `registerAdapter()`; switch active config with `switchConfig()`. No code
  changes required when adding a new provider — register a new `IProviderAdapter`.
- `ConfigGuiBridge` invokes `/home/spoq/ai-vision/tools/config-gui/target/release/ai-vision-config`
  for provider/model selection only. It NEVER reads API key values from the env file the binary writes.
  Credentials are handled exclusively by `AuthManager` + `IKeychain`.
- CLI hook contract: `apex auth login --provider <name> --json` → `{ status, provider, expires_at, message }`
  exit 0/1. Source: `src/apex/cli/auth-login.ts`.
- `IAuditLog` interface (from JAL-003) is the audit injection point for all auth actions. Pass
  `NoOpAuditLog` in tests, `AuditLog` in production.
### Gotcha
- `SecretToolKeychain.set()` sends the secret via stdin (not argv) to avoid it appearing in the
  process list. On headless VPS, `secret-tool` requires a D-Bus session + libsecret daemon running.
  Call `SecretToolKeychain.verify()` at startup and handle the thrown error gracefully.
- Config-GUI binary must be compiled before use: `cargo build --release` in
  `/home/spoq/ai-vision/tools/config-gui`. If missing, `ConfigGuiBridge.launch()` returns null
  (non-fatal). Do NOT block on binary availability — always emit the warning and continue.
- `AuthManager.doRefresh()` is a Phase 1 stub — always returns null. Future: delegate to
  `IProviderAdapter.refresh()` once OAuth endpoints are implemented per-provider.
- Provider name validation uses `/^[a-z][a-z0-9-]*$/`. Any uppercase, space, or special char
  fails login immediately. CLI tools must lowercase provider names before passing.
### Files Modified
- `src/apex/types/index.ts` (extended — AuthMethod, AuthStatus, AuthSession, AuthLoginResult, ProviderConfig, GatewayMessage, CompletionOptions, CompletionResult)
- `src/apex/auth/IKeychain.ts` (new — OS-backed secret storage interface)
- `src/apex/auth/MemoryKeychain.ts` (new — test double, in-memory only)
- `src/apex/auth/SecretToolKeychain.ts` (new — Linux libsecret via secret-tool subprocess)
- `src/apex/auth/AuthManager.ts` (new — session lifecycle, provider isolation, logout)
- `src/apex/auth/ProviderGateway.ts` (new — provider-agnostic gateway, StubProviderAdapter)
- `src/apex/auth/ConfigGuiBridge.ts` (new — launches config-gui binary, fallback warning)
- `src/apex/cli/auth-login.ts` (new — CLI hook with JSON contract)
- `tests/auth/AuthManager.test.ts` (new — 35 tests)
- `tests/auth/ProviderGateway.test.ts` (new — 10 tests)
- `tests/auth/ConfigGuiBridge.test.ts` (new — 12 tests)


## [JAL-006] — 2026-03-25
### Pattern Discovered
- `YamlPlaybookParser` uses a hand-rolled minimal YAML parser (no external deps). It handles only
  the playbook schema: top-level scalars, flat sequences, and one level of mapping within sequences.
  Do NOT add anchors or multi-document support — keep it minimal.
- Circular recursive type aliases (`type YamlMap = Record<string, YamlNode>`) cause TS2456 in
  strict mode. Fix: replace `type` with `interface` — interfaces allow forward/circular references.
  Pattern: `interface YamlMap { [key: string]: YamlNode; }` + `interface YamlList extends Array<YamlNode> {}`.
- `HeartbeatScheduler` wires `HealthChecks`, `PlaybookRunner`, and `PlaybookHealthStore` via
  constructor injection. Test overrides: pass `MockShell`, `MemoryPlaybookHealthStore`, and
  `CapturingAuditLog` (all from test doubles in respective source files).
- `DiskPressureTracker` is stateful: first-high timestamp is tracked in-memory across cycles.
  Tests inject a past timestamp via `setFirstHighAt()` to simulate sustained pressure without sleeping.
- `checkMemoryPressure()` uses `check: 'process_health'` as check name (not 'memory_pressure') to
  avoid collision. PlaybookRunner's `memory_pressure` trigger case matches on `check === 'process_health'`
  with `available_mb` metadata. This is by design — do not rename without updating both sides.
### Gotcha
- `ExecSyncShell` (production) uses `execSync` which runs synchronously. It is fine for brief health
  checks (5–10 s timeout) but would block the event loop for longer ops. Playbook steps use it too —
  keep step commands short or lower `max_runtime`.
- The `--forceExit` flag is needed in Jest because `setInterval` in `HeartbeatScheduler` keeps the
  event loop open even after tests. Tests that start the scheduler MUST call `stop()` in `afterEach`
  or use `jest --forceExit`. The jest config should include `--forceExit` in the test script.
- `staging=false` is a strict safety gate: PlaybookRunner.evaluateTriggers() checks `pb.staging === true`
  explicitly — any truthy value (including undefined) skips execution. Playbooks without `staging` field
  will fail YAML validation before reaching this gate.
### Files Modified
- `src/apex/heartbeat/YamlPlaybookParser.ts` (new — custom YAML parser; fixed circular type aliases)
- `src/apex/heartbeat/PlaybookHealthStore.ts` (new — playbook-health.json manager with atomic writes)
- `src/apex/heartbeat/HealthChecks.ts` (new — read-only health checks with DiskPressureTracker)
- `src/apex/heartbeat/PlaybookRunner.ts` (new — trigger evaluation, step execution, rollback, degrade)
- `src/apex/heartbeat/HeartbeatScheduler.ts` (new — configurable interval scheduler, prompt template)
- `src/apex/types/index.ts` (extended — Playbook*, Heartbeat* types)
- `tests/heartbeat/HeartbeatScheduler.test.ts` (new — 75 tests covering all acceptance criteria)

## Auto-compiled from FORGE Discoveries — 2026-03-25

### PATTERNS
- **[JAL-005] AuthManager is the sole session authority — inject IKeychain**: AuthManager in src/apex/auth/AuthManager.ts manages all session lifecycle. Inject IKeychain (SecretToolKeychain in prod, MemoryKeychain in tests). Provider isolation enforced by keying sessions as session:<provider> — structural impossibility of cross-provider token reuse.
- **[JAL-005] ProviderGateway normalizes all inference — register adapters, no code changes**: ProviderGateway in src/apex/auth/ProviderGateway.ts is the provider-agnostic inference entry point. Register IProviderAdapter instances at startup. switchConfig() changes provider+model. StubProviderAdapter is the Phase 1 stand-in.

### GOTCHAS
- **[JAL-005] SecretToolKeychain requires D-Bus + libsecret daemon on headless VPS**: secret-tool is a D-Bus client. On headless VPS (Hostinger), the libsecret daemon may not be running. Call SecretToolKeychain.verify() at startup and handle the thrown error — fall back to prompting re-login rather than crashing.
- **[JAL-005] ConfigGuiBridge binary must be compiled before use — cargo build --release**: The config-gui binary at /home/spoq/ai-vision/tools/config-gui/target/release/ai-vision-config must be compiled. If absent, ConfigGuiBridge.launch() returns null with a non-fatal warning. Never block on binary availability.
- **[JAL-005] AuthManager.doRefresh() is a Phase 1 stub — always returns null**: Refresh requires provider-specific OAuth endpoints. Phase 1 stub logs a warn and returns null. Future: delegate to IProviderAdapter.refresh(). For now, expired tokens always require re-login.
- **[JAL-006] TypeScript circular type aliases cause TS2456 — use interfaces**: type YamlMap = Record<string, YamlNode> fails with TS2456. Fix: interface YamlMap { [key: string]: YamlNode; } + interface YamlList extends Array<YamlNode> {}.
- **[JAL-006] Jest --forceExit needed for HeartbeatScheduler setInterval leak**: setInterval in HeartbeatScheduler keeps Jest process open. Tests must call stop() in afterEach or use --forceExit.

### CONVENTIONS
- **[JAL-005] Provider name validation: /^[a-z][a-z0-9-]*$/**: All provider names must match /^[a-z][a-z0-9-]*$/. Uppercase, spaces, or special chars fail immediately. CLI tools must lowercase before passing to AuthManager.login().

