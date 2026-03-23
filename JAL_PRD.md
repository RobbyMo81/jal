# Project Apex PRD
## Engineering Narrative for a High-Agency Local Agent

### 1. Product Narrative
Project Apex is a local-first autonomous agent that executes real work on the host machine instead of returning instructions for humans to execute. The system is designed for power users managing development environments, containers, and local automation flows. Apex runs with direct system access under a strict policy firewall, produces complete audit trails, and keeps operational data local by default.

Apex is intentionally model-agnostic. Reasoning can be backed by multiple providers, but the runtime contract, policy controls, and UX behavior remain stable across models.

### 2. Problem and Operating Context
Most AI assistants fail in high-value engineering workflows because they cannot safely run shell commands, orchestrate containers, or manage local state end to end. Apex closes that gap with a host-native runtime, a deterministic approval model, and recoverable execution semantics suitable for long-running tasks.

The target users are:
1. DevOps engineers needing persistent operational assistance.
2. Full-stack developers bootstrapping local stacks quickly.
3. Conversational developers delegating repetitive setup and maintenance work.

### 3. System Story: How Apex Works End to End
The runtime loop is: interpret goal -> plan -> evaluate policy tier -> execute or request approval -> observe output -> update memory/state -> continue until success or bounded failure.

Each user request becomes a task with explicit success criteria and bounded scope. A task may include multiple shell or tool steps. Apex persists task state continuously so a crash does not erase progress or approvals.

Autonomous background operation is delivered by a heartbeat scheduler. Every 5 minutes by default (configurable 1-30), heartbeat runs read-only checks: process health, disk pressure, container status, and failed job detection. Write actions from heartbeat are restricted to pre-approved maintenance playbooks and still flow through policy constraints.

### 4. Core Runtime Capabilities
#### 4.1 Execution Engine
1. Native shell support for bash, zsh, and powershell.
2. Native Docker integration for list, start, stop, build, inspect.
3. Long-running command handling:
1. Output streams incrementally to Canvas.
2. User cancellation is always available.
3. Default force-timeout is 15 minutes unless policy extends it.

#### 4.2 Unified Canvas UX
Canvas is the operational control plane:
1. Real-time system dashboard (CPU, RAM, containers).
2. Terminal mirror with live command and output telemetry.
3. Interactive approval surfaces for risky actions.
4. Collaboration plugins for Slack and Telegram:
1. Canvas can send alerts, summaries, and approval requests to connected channels.
2. Operators can approve or deny Tier 2 actions from Slack or Telegram with signed action links or bot commands.
3. Channel interactions are mirrored back into Canvas timeline for full auditability.

### 5. Safety, Policy, and Audit Narrative
#### 5.0 Maintenance Playbooks
Maintenance playbooks are pre-approved, deterministic action sequences that heartbeat can execute without HITL approval. They are:  

1. **Format**: YAML stored at ~/.apex/policy/playbooks/{name}.yaml. Each playbook defines:
   - name, description, triggers (see 5.0.1 for trigger definitions with threshold examples)
   - steps: list of shell commands, Docker operations, or log rotations
   - max_runtime: enforced timeout
   - rollback_commands: optional steps to revert state if failure occurs
   - rollback_failure_policy: what to do if rollback fails (see 5.0.4)

**5.0.1 Trigger Thresholds and Conditions**
Playbook triggers must have quantified conditions:
- **high_disk_pressure**: Root filesystem usage >= 85% sustained for >= 5 min (evaluated every 1 min by heartbeat)
- **service_down**: Named process exit code != 0 since last heartbeat check, or process timeout (default 30s) without response
- **memory_pressure**: Available memory drops below 512 MB (configurable per playbook)
- **failed_task**: Previous task marked failed in checkpoint and no retry in flight
Custom triggers can be defined as shell test expressions (e.g., `[ $(du /tmp | tail -1 | cut -f1) -gt 500000 ]` for >500MB /tmp); heartbeat evaluates shell exit code.

**5.0.4 Rollback Failure Handling**
If a playbook's rollback_commands sequence fails (non-zero exit code):
1. Log error with playbook name, step that failed, and command output ref.
2. Mark playbook health as degraded in ~/.apex/state/playbook-health.json (prevents re-execution until manual operator review).
3. Alert operator via Canvas: "Playbook {name} executed but rollback failed; manual cleanup may be required."
4. Heartbeat does NOT attempt retry; operator must investigate and clear degraded flag.
5. Audit log entry: "playbook_rollback_failure" with full context for incident investigation.

2. **Storage**: ~/.apex/policy/playbooks/ (directory versioned with audit logging)

3. **Creation and Approval**:
   - User or operator creates a playbook YAML file and drops it in ~/.apex/policy/playbooks/ (with `staging=true` initially).
   - Canvas shows pending playbooks in a policy review panel with preview of actions.
   - Operator clicks Approve to finalize (sets `staging=false` and records approval in audit log).
   - Playbooks require explicit approval before heartbeat can execute them.

4. **Execution Control**:
   - Heartbeat executes only playbooks with `staging=false`.
   - Each execution is audit-logged with playbook name, start/end time, exit code, and command output refs.
   - Playbook failures are logged but do not halt heartbeat; heartbeat continues to next check.

5. **Examples**:
   - "rotate_logs.yaml": gzip old audit files, delete >30 days old
   - "restart_failed_container.yaml": detect stopped container, restart if previously running
   - "cleanup_tmp.yaml": remove orphaned temp files from /tmp

Maintenance playbooks decouple routine tasks from agent reasoning, improving both efficiency and auditability.

#### 5.1 Firewall Tiers
Apex classifies every action before execution:
1. Tier 1 Auto-Approve:
1. Read-only commands.
2. Package operations against an allowlist.
2. Tier 2 Human-in-the-Loop:
1. Destructive operations (rm, docker prune, chmod).
2. Non-trivial file modifications.
3. System-level changes.
4. SSH task execution.
3. Tier 3 Blocked by default:
1. sudo execution.
2. Network configuration changes.
3. User and permission manipulation.

#### 5.2 Policy Data and Governance
1. Tier 1 package allowlist lives at ~/.apex/policy/package-allowlist.json.
2. Policy file is versioned, user-editable through settings, and audit logged.
3. File operation boundary:
1. Tier 1 allows create and edit inside configured workspace roots.
2. Tier 2 required for recursive deletes, chmod/chown, writes outside workspace roots, shell profile edits, and system file edits.
4. Docker privilege model:
1. Prefer docker socket or group access.
2. If privileged execution is required, deny by default unless explicit policy exception is user-approved.

#### 5.3 Audit and Immutability
All command decisions and outcomes are logged to local JSONL audit files.
1. Append-only runtime behavior.
2. Daily rotation.
3. Hash chain integrity (prev_hash -> curr_hash).
4. Integrity verification on startup.

### 6. Model and Auth Narrative
#### 6.1 Model-Agnostic Contract
Apex uses a provider-agnostic LLM gateway with normalized APIs for completion, tool-calling, streaming, and error handling. Runtime model selection does not require code changes.

#### 6.2 Model Switching UX
Model configuration uses the shared ai-vision terminal GUI component at /home/spoq/ai-vision/tools/config-gui.
Required flow:
1. Provider.
2. Model.
3. Login and authorize.
4. Confirm.

If shared component reuse fails, Apex must fall back to a bundled equivalent and show a non-fatal warning.

#### 6.3 Login-Based Auth (No API Key Primary Path)
1. Supported auth modes: OAuth, device-code, session auth, CLI hooks.
2. CLI login hook contract:
1. apex auth login --provider <name> --json
2. stdout JSON: { "status": "ok|error", "provider": "...", "expires_at": "...", "message": "..." }
3. exit code 0 for success, 1 for failure.
3. Credential handling:
1. Store only short-lived tokens or session references in OS credential stores.
2. Never persist secrets in plaintext env files.
4. Session isolation: provider switches cannot reuse cross-provider tokens.
5. Deterministic fallback if capability is missing:
1. JSON action-plan parsing mode.
2. Explicit confirmation mode.
3. Task refusal with remediation guidance.

### 7. Data, State, and Recovery Narrative
#### 7.1 Local Data Locations
1. Audit logs: ~/.apex/logs/
2. Runtime state and checkpoints: ~/.apex/state/
3. Policy and prompt controls: ~/.apex/policy/

#### 7.2 Checkpointing
Checkpoint schema is versioned JSON and includes:
1. schema_version
2. task_id
3. goal
4. current_step
5. step_status
6. pending_approvals
7. tool_outputs_ref
8. policy_snapshot_hash
9. updated_at

**tool_outputs_ref Format:**
Tool outputs can be large (build logs, test results, dependency trees). Checkpoints store a reference instead of inline content:
- Format: SHA256 hash of output file stored in ~/.apex/state/outputs/
- If output exceeds 10 KB, store on disk; reference by hash in checkpoint.
- On recovery, fetch output file by hash.
- Cleanup: outputs are retained for 7 days (configurable) or until explicitly deleted by user.
- Dereferencing: checkpoint recovery code resolves hash → file path and reads full output if needed for continuation.

**Recoverable state:**
1. Plan graph (DAG of tool IDs and dependencies).
2. Completed and pending steps (with completion status, outputs_ref, and error details).
3. Pending approvals (approval_id, tier, action description, created_at).
4. **Resumable tool cursors**: Some tools (e.g., log streaming, file iteration, pagination) can emit cursor state (e.g., "line 1500 of 5000", "next_token=xyz"). Cursors are stored in checkpoint so tool can resume from current position on recovery instead of restarting from beginning. Cursor format is tool-specific and stored in completed_step → cursor field.

Non-recoverable state:
1. Volatile subprocess handles.
2. Transient network sockets.
3. Timer/interrupt handlers (these are reset on recovery).

#### 7.3 Crash Semantics
On crash recovery:
1. Restore latest checkpoint.
2. Mark in-flight steps interrupted.
3. Require re-approval for interrupted Tier 2 actions.
4. Resume task if policy and dependencies are valid.

Target MTTR is under 10 seconds.

### 8. Memory and Context Narrative
#### 8.1 Memory Model
Apex maintains three memory tiers:
1. Short-term working memory for active task execution.
2. Episodic memory for recent sessions.
3. Durable memory for user-approved long-term facts.

Promotion from episodic to durable requires all three:
1. Repeated usefulness across at least two sessions.
2. Confidence score at least 0.8 (calculated as: (times_retrievals_with_success / times_retrievals_total) at end of session, must be >=0.8 for two independent sessions).
3. Explicit user approval.

**Confidence Score Calculation:**
Confidence is determined by direct user feedback only (not LLM-determined, to ensure determinism and auditability):
- Every time a memory item is retrieved and used in a task, Canvas shows a transient **"Was this fact helpful?"** control (thumbs up/down) in the memory context section.
- User can provide immediate feedback without disrupting task flow.
- At session end, calculate confidence_score = (positive_feedback_count) / (total_retrievals) for each episodic memory item.
- Items with confidence >= 0.8 in two different sessions are candidates for durable promotion.
- System marks them as "promotable_items" and shows in memory review UI with source sessions and example usages.
- If no feedback is provided on a retrieval, it counts as neutral (neither helpful nor unhelpful); only explicit feedback affects confidence.

**Memory Review UX:**
Canvas includes a Memory Panel (accessible from sidebar) showing:
1. Promotion candidates: Items ready for durable promotion (shown with source sessions, confidence scores, example usages).
2. Approve: Moves to durable memory; marked with explicit_approved=true and promotion_date.
3. Reject: Discards from episodic; removes from candidates permanently.
4. Revoke: Existing durable memory items can be revoked, moving back to episodic or deleting outright.
5. All actions audit-logged with user identity and timestamp.

Memory review UI is available at runtime; no code changes required (part of Canvas dashboard).

Episodic retention defaults:
1. TTL 30 days from last access or creation, whichever is later.
2. LRU eviction when storage quota is exceeded (default quota 50 MB per workspace).

#### 8.2 Context Window Strategy
Each model call uses a fixed budget partition by default:
1. 25% system policy.
2. 35% active task state.
3. 25% recent actions.
4. 15% retrieved memory.

Budgets are configurable per model profile (user can adjust percentages in ~/.apex/config/model-profiles.json).

**Model Size Thresholds and Adaptive Strategy:**
Context limits are classified as:
- **Large**: >= 100K tokens (e.g., Claude 3, GPT-4 Turbo) → Use default 25/35/25/15 split.
- **Medium**: 16K - 100K tokens (e.g., GPT-3.5, Claude 2) → Scale total budget by factor 0.75; percentages remain 25/35/25/15 (e.g., if large model context limit is 100K tokens with 75K usable budget, medium model 100K context limit gets 75K × 0.75 = 56.25K usable budget, split 25/35/25/15).
- **Small**: < 16K tokens (e.g., older instruct models) → Scale by factor 0.50, with minimum floor: system_policy never drops below 10%, active_task never below 15%.

On context limit breach (remaining_tokens < required_minimum):
1. Truncate least-valuable context segments in reverse order: retrieved_memory → recent_actions → active_task_state → system_policy (never truncate policy).
2. If still over limit, summarize active_task_state and regenerate summary from local state before next call.
3. If still insufficient, refuse to invoke model and return error requiring user intervention (fallback to explicit confirmation mode).

Large tool output handling:
1. Chunk and summarize for prompt context (keep first 500 tokens + last 500 tokens of large outputs; summarize middle section).
2. Keep raw output local in ~/.apex/state/outputs/ and reference by pointer (SHA256 hash).
3. Avoid inlining full logs by default.

Eviction policy is deterministic:
1. Remove least-recently-used transient details first.
2. Regenerate summaries from local state as needed.
3. Order of eviction: memory items (oldest) → recent_actions (oldest) → active_task detail sections (lowest relevance score).

Heartbeat uses a dedicated compact prompt template with read-only default actions. Templates are versioned at ~/.apex/policy/prompts/heartbeat.v{n}.md, checksum tracked, and governed by policy update controls.

### 9. Privacy and Security Narrative
Privacy boundary:
1. Local by default for code, logs, memory, and command history.
2. Only minimized policy-filtered reasoning context can leave host to model provider APIs.
3. No raw repository snapshots or full command transcripts sent by default.
4. Slack and Telegram integrations are opt-in and disabled by default.
5. Outbound chat payloads must be policy-filtered summaries; secrets, tokens, and raw command output are redacted unless explicitly user-approved.

Credential boundary:
1. OS-backed secure storage only.
2. Refresh and rotation supported without manual file edits.
3. Slack bot tokens and Telegram bot tokens are stored in OS credential storage and never in plaintext config files.

### 10. Performance and Reliability Targets
1. Local shell response target: under 100 ms.
2. User-facing LLM roundtrip target: under 5 s.
3. Crash recovery MTTR target: under 10 s.
4. Task completion target: at least 90% autonomous completion without manual fallback.
5. Safety bypass target: 0.
6. Auth success target: above 95% without manual config edits.

### 11. Delivery Plan
1. Phase 1 MVP:
   1. Shell execution.
   2. Docker lifecycle management.
   3. Tiered firewall with HITL.
   4. File operations within policy boundaries.
   5. Integrated model switching terminal GUI.
   6. Heartbeat with read-only checks and maintenance playbooks.
   7. Checkpoint-based crash recovery.
   8. Memory model and context budgeting (core runtime, no plugin dependency).

2. Phase 2:
   1. Expanded tool catalog.
   2. Reasoning and context optimization.
   3. Performance tuning.
   4. **Slack and Telegram Canvas plugin integrations for alerts and remote approvals (entire §14 Plugin Interface Contract is Phase 2, including all webhook delivery modes, identity mapping, role policy, and redaction levels in this plan revision).**

3. Phase 3:
   1. Custom tool definitions.
   2. Workflow composition.
   3. Multi-machine SSH coordination only on allowlisted hosts and only via Tier 2 approval.

### 12. Out of Scope for MVP
1. Native orchestration of cloud resources across AWS, Azure, GCP.
2. Desktop GUI automation outside terminal and web surfaces.
3. Multi-user RBAC collaboration model.
4. Advanced Windows powershell parity in v1.

### 13. Acceptance Criteria
1. Auth and model switching:
1. User logs in without API key entry in standard flow.
2. Secure storage contains tokens; logs and env files do not contain plaintext secrets.
3. Provider and model switch requires no code changes.
4. Median switch time target is under 2 minutes, excluding external consent delays.
5. Provider sessions are isolated.
6. Expired tokens auto-refresh when possible; otherwise re-login prompt appears.
7. Logout removes local session artifacts and blocks further inference until re-auth.

2. Safety and audit (Phase 1 core, plugin-specific features are Phase 2):
1. Every executed action has tier classification and decision record.
2. Tier 2 always requires explicit approval.
3. Audit integrity checks pass on startup.
4. **[Phase 2]** Approvals originating from Slack or Telegram are signed, identity-mapped, and logged with the same fidelity as in-Canvas approvals.

3. Recovery and memory:
1. Crash during execution resumes from checkpoint with interrupted step semantics.
2. Interrupted Tier 2 action never resumes without re-approval.
3. Memory promotions require explicit user approval and are revocable.

3. **Collaboration plugins (Phase 2 feature)**:
1. Slack and Telegram can be enabled independently per workspace.
2. Plugin disconnect immediately revokes remote approval capability.
3. Canvas remains fully functional when plugins are unavailable.

4. **Heartbeat and maintenance (Phase 1 feature)**:
1. Heartbeat runs on 5-minute interval (configurable 1-30 min) and performs read-only checks by default.
2. Approved maintenance playbooks can execute write operations via heartbeat.
3. All heartbeat actions (checks and playbook executions) are audit-logged with timestamp, action, exit code, and output refs.
4. Playbooks must be pre-approved in Canvas (staging=false) before heartbeat execution.
5. Failed playbook steps are logged; execution continues to next heartbeat cycle unless rollback fails (see §5.0.4).

5. **Context window management (Phase 1 feature)**:
1. Context budget allocation enforces fixed percentages (25/35/25/15) for large models (>=100K tokens).
2. Medium models (16K-100K) scale total budget by 0.75; percentages stay same.
3. Small models (<16K) scale by 0.50 with minimum floors (system_policy >= 10%, active_task >= 15%).
4. Budget breach triggers truncation in specified order; overflow prevention avoids silent loss of critical context.
5. Truncation and eviction policies are deterministic and produce consistent behavior across model size changes.

### 14. Plugin Interface Contract (Slack and Telegram)
This section defines the required contract between Canvas and collaboration plugins so implementations remain interchangeable and testable.

#### 14.1 Event Types
Canvas publishes normalized events to plugins:
1. approval.requested
2. approval.resolved
3. task.summary
4. alert.critical
5. plugin.health

#### 14.2 Outbound Event Envelope
All outbound plugin events must use this envelope:
1. event_id: UUID
2. event_type: string
3. workspace_id: string (UUID of Slack or Telegram workspace; also used locally to isolate multi-workspace Apex instances)
4. task_id: string
5. tier: 1|2|3 (when applicable)
6. created_at: ISO-8601
7. payload: object
8. redaction_level: minimal|standard|strict (see 14.2.8 for definitions)
9. signature: HMAC-SHA256 over canonical JSON

#### 14.2.8 Redaction Level Definitions
1. **minimal**: Omit secrets (tokens, keys, passwords), API responses with PII, and raw command output. Include action class, risk reason, and approval status.
2. **standard**: Additionally omit code snippets, file paths, environment variable names, and inferred internal system details. Include only task goal, risk class, and approval chain.
3. **strict**: Omit all details except approval result, outcome, and timestamp. No identifiable system state or reason visible to plugin.

#### 14.2.9 Interaction Modes
Two complementary modes allow operators to act on approvals:
1. **Signed action links**: Slack/Telegram message contains approve/deny links that are signed and nonce-protected. Clicking invokes inbound callback (§14.4).
2. **Bot commands**: Operators type bot commands (e.g., @apex-bot approve <approval_id>). Bot parses command, validates syntax, and dispatches inbound callback. Command syntax is plugin-specific but must include approval_id and action (approve|deny) as required fields.

Both modes produce identical inbound callbacks and audit records.

#### 14.3 Approval Action Payload
Tier 2 remote approval payload must include:
1. approval_id
2. requested_action_summary
3. risk_reason
4. expires_at
5. approve_action_token
6. deny_action_token
7. required_role (optional; if specified, only actors with this role can use the tokens)

Approval tokens must be single-use, short-lived (default TTL 10 minutes), and bound to workspace_id + approval_id + required_role (if applicable). Tokens are invalidated on first use (approve or deny), on expiry, or if actor lacks required_role when callback is validated.

**In-flight Approvals on Plugin Disconnect:**
If a plugin (Slack or Telegram) disconnects or becomes unavailable:
1. Approval tokens already sent but not yet acted on are immediately marked expired.
2. Actors attempting to use expired tokens receive "approval expired" error.
3. Canvas reverts Tier 2 action to pending-approval state and re-prompts local operator for approval.
4. No Tier 2 decisions are made during plugin unavailability; system reverts to HITL-only mode.

#### 14.4 Inbound Webhook Delivery Architecture
Since Apex runs locally behind NAT/firewalls, direct inbound webhooks are not reliably available. Apex supports three delivery modes:

**14.4.0 Plugin Coordinator (Local Service)**
The plugin coordinator is an Apex-local service that manages plugin communication without requiring cloud infrastructure or breaking the local-first premise:
- **Runtime**: Embedded lightweight HTTP server in Apex process (no external dependency).
- **Data**: Per-workspace_id message queue stored at ~/.apex/state/plugin-queues/.
- **Interface**: Implements standard HTTP endpoints:
  - `GET /apex/plugin-actions/{workspace_id}` — Returns queued actions (polling interface) with ACK-on-fetch semantics.
  - `POST /apex/plugin-actions/{workspace_id}/ack/{action_id}` — Acknowledges consumption, deletes from queue.
  - `POST /apex/plugin-webhooks/{workspace_id}` — Relays webhook callbacks from tunnel/relay endpoints (used in relay/cloud modes).
- **No external calls**: Coordinator never initiates outbound requests; it only receives from Slack/Telegram via operator's configured relay endpoint or stores polling-drillable messages locally.
- **Isolation**: Each Apex instance has independent coordinator; multiple instances do not share queues.

1. **Polling mode (recommended for local-first)**: 
   - Apex periodically polls its local plugin coordinator for pending actions (default 10s interval, configurable via ~/.apex/config/plugin-delivery.yaml).
   - Coordinator maintains per-workspace_id message queue in local storage.
   - Apex fetches queued actions, processes them locally, and acknowledges consumption.
   - No inbound network requirements; compatible with all network topologies.
   - **Polling-specific failure handling**: If poll request fails (internal server error, malformed response), Apex logs error and retries poll on next scheduled interval. Failures do not escalate to retry queue; plugin is marked degraded after 5 consecutive failed polls.

2. **Relay/tunnel mode (optional, for low-latency networks; uses push retry policy from §14.6)**:
   - Operator configures a relay service (e.g., ngrok, Tailscale funnel, or private tunnel) to expose a local endpoint.
   - Relay endpoint URL is registered at Slack/Telegram and configured locally (not with Apex coordinator; coordinator only handles polling mode queues).
   - Slack/Telegram webhooks push directly to Apex's relay endpoint, bypassing coordinator.
   - Apex receives inbound plugin actions and processes them with standard callbacks.
   - Operator is responsible for secure relay configuration and credential management (relay credentials stored in OS keychain, never in config files).
   - Push delivery failures use exponential backoff retry policy (see §14.6).

3. **Cloud-hosted receiver mode (advanced, breaks local-first premise; uses push retry policy from §14.6)**:
   - Operator hosts a receiver service on cloud infrastructure.
   - Slack/Telegram webhooks push to cloud receiver (managed by operator).
   - Receiver proxies validated actions to Apex via secure channel (e.g., WebSocket, authenticated API, mutual TLS).
   - Receiver credentials are managed separately from Apex instance (should be service identity, not user credentials).
   - Not recommended for local-first deployments; documented for completeness.
   - Push delivery failures use exponential backoff retry policy (see §14.6); fails over to local-only if receiver is unavailable.

**Default deployment uses polling mode.** Relay and cloud modes are opt-in and must be explicitly configured in ~/.apex/config/plugin-delivery.yaml with full documentation of security/privacy implications.

#### 14.4.1 Inbound Action Contract
Plugin actions received via any delivery mode must provide:
1. event_id
2. approval_id
3. action: approve|deny
4. actor_id (from mapping table; see 14.5)
5. actor_display
6. actor_channel
7. acted_at
8. callback_signature (HMAC-SHA256 over canonical JSON, same key as outbound)

Inbound actions without valid signature, expired token, unmapped actor_id, or stale acted_at must be rejected and audit logged as denied.

#### 14.5 Identity and Authorization Mapping

**14.5.1 Actor Identity Establishment**
Actor-to-local identity mapping is stored in ~/.apex/config/plugin-actors.json (user-maintained, audit-logged):
```json
{
  "slack": {
    "@alice": "alice-local-id",
    "@bob": "bob-local-id"
  },
  "telegram": {
    "alice_tg_user_id": "alice-local-id",
    "bob_tg_user_id": "bob-local-id"
  }
}
```

Setup flow:
1. Operator manually creates or edits plugin-actors.json with Slack display names / Telegram user IDs and corresponding local Apex identities.
2. Canvas shows a setup guide suggesting import from current Slack workspace members or Telegram contacts (operator still confirms each mapping).
3. Unmapped actors in inbound actions are rejected with audit log entry and optional Canvas notification to operator.

**14.5.2 Role Policy for Approval Classes**
Role policy is stored in ~/.apex/config/plugin-roles.json:
```json
{
  "approver": ["alice-local-id", "bob-local-id"],
  "auditor-only": ["charlie-local-id"]
}
```

Approval tiers support role restrictions:
1. Tier 2 approval requests include required_role field (e.g., "approver").
2. Canvas checks actor's assigned roles before issuing approval tokens.
3. Actor must have all roles in required_role array to be issued a token.
4. Mismatch results in rejection and audit log entry.

**14.5.3 Token Actor Binding Timing**
Approval tokens are issued at the moment Canvas sends an approval request:
1. Canvas identifies the specific actors / roles that may approve (from role policy).
2. Generates single-use, TTL-bound (10-min default) approval tokens.
3. Sends tokens only in the approval message to that actor (not broadcast to channel).
4. Tokens encode workspace_id, approval_id, and required_role in signed payload (verified on inbound callback).
5. If multiple actors should approve in sequence, separate approval requests with separate tokens are issued.

**14.5.4 Unmapped Actor Behavior**
When an inbound action includes actor_id that does not exist in plugin-actors.json:
1. Action is rejected with audit log entry: "unmapped_actor_approval_denied".
2. Canvas notifies operator: "Approval from @<actor_channel> cannot be processed; actor not registered in plugin-actors.json".
3. Operator can manually map the actor in plugin-actors.json and retry (plugin retries are manual at operator discretion, or actor re-approves).
4. No silent failures; every rejection is observable in audit logs and Canvas timeline.

#### 14.6 Delivery Guarantees and Reliability
1. **Outbound delivery semantics** (relay/cloud modes): at-least-once (uses retry policy below).
2. **Polling mode semantics** (recommended): at-most-once per poll interval. Queued messages survive Apex restarts; acknowledged messages are deleted.
3. Idempotency key: event_id for outbound, approval_id + actor_id + action for inbound.
4. **Push retry policy** (relay/cloud webhook mode only): exponential backoff (1s, 2s, 4s, 8s, 16s; max 5 attempts).
5. **Polling retry policy**: Failed poll requests retry on next scheduled interval (e.g., 10s later); no exponential backoff (coordinator is local, so transient failures are rare and rapid retry is not beneficial).
6. On repeated delivery failure (5+ failed outbound pushes or 5+ consecutive failed polls), Canvas marks plugin degraded and continues local-only operation.
7. **Signed action link format** (mode-agnostic across polling/relay/cloud): `{approval_id}:{actor_id}:{action}:{nonce}:{timestamp}:{hmac_signature}` (format identical across modes; delivery mechanism differs).

#### 14.7 Observability and Audit Mapping
1. Every outbound event and inbound action is linked to audit log records via event_id.
2. Approval resolution records must include source channel (canvas|slack|telegram).
3. Secret material (tokens, signatures, raw provider payloads) must never be logged.

#### 14.8 Security Controls
1. Webhook endpoints require TLS and signature verification.
2. Replay protection uses nonce + timestamp window (default 5 minutes).
3. **Bot scopes** are least-privilege and limited to required channel operations:
   - **Slack**: `users:read` (for member import), `conversations:read` (channel list), `chat:write` (post messages), `reactions:read`, `interactions:read` (for button/command clicks).
   - **Telegram**: Standard bot permissions (no advanced group admin scope required for MVP; basic ability to send/receive messages).
   - Note: Member/contact import (§14.5.1) uses `users:read` and `conversations:read`; if operator opts out of import, declare only `chat:write` + `interactions:read` to minimize permission footprint.

#### 14.9 Compatibility
1. Contract version is declared as plugin_contract_version in plugin metadata.
2. Backward-compatible additions are minor version bumps; breaking changes are major version bumps.
3. Canvas must reject unknown major versions with explicit operator guidance.
