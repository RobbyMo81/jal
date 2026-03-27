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


## [JAL-007] — 2026-03-25
### Pattern Discovered
- `CheckpointStore` in `src/apex/checkpoint/CheckpointStore.ts` handles all checkpoint persistence.
  Saves atomically via write-to-temp + rename. Maintains a `latest.json` pointer file so
  `loadLatest()` finds the most recently saved task without scanning all files.
- `OutputStore` in `src/apex/checkpoint/OutputStore.ts` manages tool output refs.
  Outputs ≤ 10 KB are inlined in `ToolOutputRef.inline`; larger outputs are written to
  `~/.apex/state/outputs/<sha256>`. SHA256 is always verified on `retrieve()`. Retention
  is controlled by `APEX_OUTPUT_RETENTION_DAYS` (default 7). Call `cleanup()` at startup.
- `CrashRecovery` in `src/apex/checkpoint/CrashRecovery.ts` orchestrates recovery:
  (1) load latest checkpoint, (2) mark `in_progress` → `interrupted`, (3) queue
  `PendingApproval` for every interrupted Tier 2 step, (4) call `resetForRecovery()` on
  all `INonRecoverableStateReset` implementations, (5) verify all output hashes, (6) persist.
  Recovery is fully synchronous and should complete in well under 10 s.
- `INonRecoverableStateReset` is the contract for components that hold OS handles (subprocess
  PIDs, sockets, timers). ShellEngine and HeartbeatScheduler should implement it when wired
  into `CrashRecovery`.
### Gotcha
- `CrashRecovery.recover()` does NOT call `resetForRecovery()` when no checkpoint exists
  (early return). Components must not assume reset runs on every startup — only on recovery.
- `tool_outputs_ref` map keys are arbitrary strings (step IDs, tool call IDs). The map is
  checked per-entry during `verifyOutputs()`. If an on-disk file is missing (expired),
  verification fails and `output_verification_errors` will be non-empty. Do not resume
  the task before investigating these errors.
- `pending_approvals` deduplication: `CrashRecovery` checks `step_id` before appending.
  If a crash happened after a Tier 2 approval was already queued (but before approval was
  granted), the existing entry is kept rather than doubled.
- `CheckpointStore.list()` filters on `.checkpoint.json` suffix. The `latest.json` file and
  any `.tmp` files are intentionally excluded — do not add logic to include them.
### Files Modified
- `src/apex/types/index.ts` (extended — StepStatus, ToolCursor, ToolOutputRef, PendingApproval, CheckpointStep, Checkpoint)
- `src/apex/checkpoint/OutputStore.ts` (new)
- `src/apex/checkpoint/CheckpointStore.ts` (new)
- `src/apex/checkpoint/CrashRecovery.ts` (new)
- `tests/checkpoint/OutputStore.test.ts` (new — 22 tests)
- `tests/checkpoint/CheckpointStore.test.ts` (new — 18 tests)
- `tests/checkpoint/CrashRecovery.test.ts` (new — 17 tests)

## Auto-compiled from FORGE Discoveries — 2026-03-25

### PATTERNS
- **[JAL-007] CrashRecovery only resets state when a checkpoint exists**: CrashRecovery.recover() returns early when loadLatest() returns null — stateResets are NOT called. Components must not assume reset runs on every startup, only on recovery.
- **[JAL-007] CheckpointStore latest.json is a pointer file, not a snapshot**: latest.json stores { task_id, updated_at }. Loading latest always re-reads the full .checkpoint.json. If the pointer points to a deleted task, loadLatest() returns null.
- **[JAL-007] INonRecoverableStateReset is the wiring point for ShellEngine and HeartbeatScheduler**: JAL-008+ should implement INonRecoverableStateReset on ShellEngine (cancel activeExecutions) and HeartbeatScheduler (stop interval). Pass them to CrashRecovery constructor at startup.

### GOTCHAS
- **[JAL-007] tool_outputs_ref missing-file errors must block task resume**: CrashRecovery.recover() returns output_verification_errors. If non-empty, at least one on-disk output file is missing (expired/corrupted). Do NOT resume the task — the agent will be missing required tool context.


## [JAL-008] — 2026-03-25
### Pattern Discovered
- Three-tier memory lives in `src/apex/memory/`: `EpisodicStore.ts`, `DurableStore.ts`, `FeedbackStore.ts`, `MemoryManager.ts`, `ContextBudget.ts`, `ModelProfiles.ts`.
- `EpisodicStore` is workspace-scoped: one JSON file per workspace at `~/.apex/state/memory/episodic/<hash>_<safe-name>.json`. TTL is 30 days from last_accessed_at (reset on every retrieval). LRU eviction fires automatically after store() when total_bytes > 50 MB.
- `FeedbackStore` enforces ballot-stuffing prevention: one record per (item_id, session_id) pair — later feedback for the same pair replaces the earlier one.
- `ContextBudget.computeBudget()` classifies model size via `ModelProfiles.getModelSize()` and applies scaling (1.0 / 0.75 / 0.50). Minimum floors (system_policy ≥10%, active_task_state ≥15%) are enforced only for small models.
- Tool output chunking in `ContextBudget.chunkToolOutput()` delegates full-content storage to `OutputStore` (reused from JAL-007). SHA256 hash appears in the separator comment so operators can locate the full file.
- `MemoryManager.promoteToDurable()` is the single promotion gate: throws if `userApproved !== true`, if item not in episodic store, or if criteria not met. No code path bypasses this check.
### Gotcha
- `EpisodicStore.evict()` uses oldest `last_accessed_at` for LRU order. If you store an item and immediately call `get()`, the timestamp advances and the item becomes harder to evict — intentional TTL-reset behavior.
- `ContextBudget.enforceLimit()` operates at item granularity (whole strings removed), not at character/byte level. If a single item is larger than the entire budget, the result is an empty array for that segment — the caller must guard against this.
- `ModelProfiles` merges built-in defaults with the user's `~/.apex/config/model-profiles.json` on every load — new default entries appear without requiring a file migration.
- Token approximation: 1 token ≈ 4 UTF-8 bytes. This is a heuristic — never use for exact billing.
### Files Modified
- `src/apex/memory/EpisodicStore.ts` (new)
- `src/apex/memory/DurableStore.ts` (new)
- `src/apex/memory/FeedbackStore.ts` (new)
- `src/apex/memory/MemoryManager.ts` (new)
- `src/apex/memory/ContextBudget.ts` (new)
- `src/apex/memory/ModelProfiles.ts` (new)
- `src/apex/types/index.ts` (extended — MemoryItem, MemoryFeedbackRecord, FeedbackFile, PromotionCandidate, EpisodicMemoryFile, DurableMemoryFile, ContextBudgetAllocation, BudgetSegmentAllocation, ModelProfile, ModelProfilesFile, ToolOutputChunk, MemoryTier, UserFeedback, ContextSegment, ModelSize)
- `tests/memory/EpisodicStore.test.ts` (new)
- `tests/memory/DurableStore.test.ts` (new)
- `tests/memory/FeedbackStore.test.ts` (new)
- `tests/memory/MemoryManager.test.ts` (new)
- `tests/memory/ContextBudget.test.ts` (new)
- `tests/memory/ModelProfiles.test.ts` (new)

## Auto-compiled from FORGE Discoveries — 2026-03-25

### PATTERNS
- **[JAL-008] EpisodicStore workspace filename uses SHA256 prefix + safe name**: workspace_id hashed (first 8 hex) + sanitized to prevent collisions.
- **[JAL-008] ContextBudget.enforceLimit() removes whole items not partial text**: Truncation is at item granularity. If single item exceeds full budget, segment empties. Callers must guard.
- **[JAL-008] ModelProfiles merges built-in defaults on every load**: New default entries injected on load if missing — no migration needed.

### GOTCHAS
- **[JAL-008] MemoryManager.promoteToDurable() is the single auto-promotion safety gate**: Throws immediately if userApproved !== true. No bypass path exists.


## JAL-009 — 2026-03-26
### Pattern Discovered
- `ApexRuntime` is the single wiring point for all Phase 1 services. Instantiate it once and pass it to the REPL or any other consumer. All services are public readonly properties.
- `Repl` constructor accepts `runtimeOptions.onApprovalRequired` to override the readline-based Tier 2 prompt — use this for test doubles instead of mocking readline.
- `onApprovalRequired` is wired to BOTH `TieredFirewall` and `PolicyFileOps` via the same callback — changing the approval UX requires updating only one place in `ApexRuntime`.
### Gotcha
- If `runtimeOptions.onApprovalRequired` is provided to Repl, it replaces the readline prompt entirely. Tests MUST call `approvalService.resolve(token.id, bool)` explicitly from within the callback, or `classify()` will hang and the test will time out.
- `ts-node` must be installed as a devDependency for `npm run apex` to work. It was absent from the initial package.json — added in JAL-009.
- `readline.Interface` in the Repl must be created BEFORE the runtime, because `handleTier2Approval` captures `this.rl`. The approval callback is then safely passed to `ApexRuntime` after `this.rl` exists.
### Files Modified
- `src/apex/runtime/ApexRuntime.ts` (new)
- `src/apex/repl/Repl.ts` (new)
- `src/apex/main.ts` (new)
- `package.json` (added ts-node devDependency)
- `tests/runtime/ApexRuntime.test.ts` (new)
- `tests/repl/Repl.test.ts` (new)

## JAL-010 — 2026-03-26
### Pattern Discovered
- `SnapshotCollector` is fully injectable via `IHeartbeatShell` — all five collectors (processes, containers, disk, memory, network) are independently testable with `StubShell`.
- `DeltaAnalyzer.analyze(null, curr)` returns empty deltas on first pulse — callers need not special-case this; the null-prev contract is part of the public API.
- `HeartbeatScheduler` accumulates `pendingNarrativeDeltas` across pulses and resets them only on narrative write. `narrativePulsesN` is configurable per-instance (default 12, env `APEX_NARRATIVE_PULSES`).
- Heartbeat narratives bypass `MemoryManager.promoteToDurable()` and write directly to `DurableStore` — they are system-generated context, not user-memory promotions.
- `ApexRuntime.identityDocsDir` defaults to `src/apex/` (via `__dirname`). Override with `identityDocsDir` option in tests to avoid polluting the real identity docs.
### Gotcha
- `DurableStore` must have a `has(id)` method for tests — verify it exists before adding narrative-write assertions.
- Soul.md and Behavior.md must live at `src/apex/` (not `src/`) — `APEX_SRC_DIR` resolves to `path.join(__dirname, '..')` from `src/apex/runtime/`.
- `CapturingAuditLog` must be exported from `src/apex/policy/AuditLog` for test files to use it. If missing, add it or create a local stub.
### Files Modified
- `src/apex/heartbeat/EnvironmentSnapshot.ts` (new)
- `src/apex/heartbeat/DeltaAnalyzer.ts` (new)
- `src/apex/heartbeat/HeartbeatScheduler.ts` (updated — JAL-010 integration)
- `src/apex/runtime/ApexRuntime.ts` (updated — identity doc loading + narrative read)
- `src/apex/repl/Repl.ts` (updated — ambient status print)
- `src/apex/types/index.ts` (updated — JAL-010 types added)
- `src/apex/Soul.md` (new)
- `src/apex/Behavior.md` (new)
- `tests/heartbeat/EnvironmentSnapshot.test.ts` (new)
- `tests/heartbeat/DeltaAnalyzer.test.ts` (new)
- `tests/heartbeat/ContextAwareness.test.ts` (new)

## [JAL-011] — 2026-03-27
### Pattern Discovered
- `GoalLoop` at `src/apex/agent/GoalLoop.ts` pre-classifies each step via `runtime.firewall.classify()` BEFORE execution, then executes via a separate `bypassEngine = new ShellEngine()` (no firewall). This avoids double Tier-2 prompting that would occur if shellEngine re-classified after GoalLoop already got approval.
- `ApexRuntime.providerGateway` is now a public field. If not injected via `ApexRuntimeOptions.providerGateway`, a StubProviderAdapter is registered and `authManager.login('stub', ...)` is called in `start()`. Tests inject their own gateway.
- LLM JSON parsing extracts the first `[...]` block from the response — handles surrounding text gracefully without breaking on preamble.
### Gotcha
- `bypassEngine` has no firewall — GoalLoop MUST call `runtime.firewall.classify()` before every `bypassEngine.exec()` call. Never skip this or Tier 3 commands will execute.
- The stub gateway auto-login (`auth_method: 'cli-hook'`) only runs when `isStubGateway === true`. Injected gateways must pre-authenticate their own providers in tests.
- Checkpoint `policy_snapshot_hash` uses a deterministic dummy hash in Phase 1 (no actual policy snapshot file). Phase 2 should wire this to the real policy file hash.
### Files Modified
- `src/apex/agent/GoalLoop.ts` (new)
- `src/apex/runtime/ApexRuntime.ts` (updated — providerGateway field + stub auto-login)
- `src/apex/repl/Repl.ts` (updated — goal command dispatch + handleGoal)
- `src/apex/types/index.ts` (updated — GoalStep + GoalStepTool types)
- `tests/agent/GoalLoop.test.ts` (new — 15 tests)

## [JAL-012] — 2026-03-27
### Pattern Discovered
- Tool catalog lives at `src/apex/tools/`. Each tool file exports one or more classes implementing `ITool: { name, description, tier, execute(args) }`.
- `ToolRegistry` at `src/apex/tools/ToolRegistry.ts` registers all tools and exposes `catalog()` for LLM prompt injection. GoalLoop accepts `toolRegistry` option and injects catalog into the decompose prompt.
- Tools classify via `firewall.classify('shell.exec', { command })` BEFORE executing via `bypassShell`. The firewall's existing TIER2_SHELL_RULES already covers `kill` → Tier 2. Tools never spawn processes directly.
- `system:env` reads `process.env` directly (no shell) and redacts values where the key matches `/token|key|password|secret|api|auth|credential|private/i`.
- `network:curl` uses `--get` flag to enforce HTTP GET. URL validated against `/^https?:\/\//i` before any firewall call.
- `WorkspaceRootsConfig.add()` is the method to add workspace roots (not `addRoot()`).
### Gotcha
- `AutoApproveTier2Firewall` test double must cast as `unknown` first, then cast to `TieredFirewall` to satisfy TypeScript — `DenyFirewall` likewise. These stubs don't extend TieredFirewall.
- `file:diff` exits 1 when files differ (POSIX spec) — this is NOT an error condition. Callers should inspect stdout, not just exit_code.
- `log:log-grep` exits 1 when grep finds no matches — also not an error. Same pattern as diff.
- `process:top-n` uses `ps aux --sort=-%cpu | head -n ${n+1}` — the +1 preserves the header row.
- ShellEngine's injection check (`/[;`\r\n]|\$\(|\$\{/`) runs on the full command string. All tool args are wrapped in `sq()` (single-quote escape) before embedding in commands.
### Files Modified
- `src/apex/tools/ToolRegistry.ts` (new)
- `src/apex/tools/FileTools.ts` (new)
- `src/apex/tools/ProcessTools.ts` (new)
- `src/apex/tools/NetworkTools.ts` (new)
- `src/apex/tools/LogTools.ts` (new)
- `src/apex/tools/SystemTools.ts` (new)
- `src/apex/agent/GoalLoop.ts` (updated — toolRegistry option + catalog in prompt)
- `src/apex/runtime/ApexRuntime.ts` (updated — toolRegistry field + all 18 tools registered)
- `src/apex/types/index.ts` (updated — ToolResult + ITool types)
- `tests/tools/ToolRegistry.test.ts` (new — 45 tests)

## Auto-compiled from FORGE Discoveries — 2026-03-27

### PATTERNS
- **[JAL-012] Tools pre-classify via firewall then execute via bypassShell**: firewall.classify(shell.exec, {command}) before every bypassShell.exec(). Existing TIER2_SHELL_RULES covers kill -> Tier 2 automatically.
- **[JAL-012] ToolRegistry.catalog() formats LLM-injectable tool list**: catalog() = Available tools:
  - <name>: <description> [Tier N]. GoalLoop injects via toolRegistry option.

### GOTCHAS
- **[JAL-012] file:diff and log:log-grep exit_code=1 on no-match is NOT an error**: POSIX diff exits 1 when files differ; grep exits 1 when no matches. Callers should inspect stdout, not check exit_code === 0.
- **[JAL-012] system:env reads process.env directly — no shell subprocess**: EnvTool reads process.env in JS, redacts via SECRET_KEY_RE = /token|key|password|secret|api|auth|credential|private/i, returns sorted lines.


## Auto-compiled from FORGE Discoveries — 2026-03-27

### PATTERNS
- **[JAL-013] CanvasServer binds 127.0.0.1 by default — port 0 for tests**: Pass port:0, host:127.0.0.1 in CanvasServerOptions to get OS-assigned port. Read httpServer.address().port after start() to find actual port.
- **[JAL-013] ApexRuntime session token generated in start() not constructor**: CanvasServer constructed with empty sessionToken; setSessionToken() called in start() after randomBytes(32). Call start() before connecting WS clients.

### GOTCHAS
- **[JAL-013] CanvasEvent cast to Record<string,unknown> requires unknown intermediary**: CanvasEvent has no index signature. Direct cast to Record<string,unknown> is TS2352. Use (e as unknown as Record<string,unknown>) instead.

