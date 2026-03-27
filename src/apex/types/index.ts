// src/apex/types/index.ts — Project Apex shared type definitions
// Agents: extend this file as new interfaces are defined. Do not use `any` in public interfaces.

// ── Policy Tiers ──────────────────────────────────────────────────────────────

export type PolicyTier = 1 | 2 | 3;

export interface TierDecision {
  tier: PolicyTier;
  action: string;
  reason: string;
  approved: boolean;
  approval_id?: string;
  decided_at: string;
}

// ── Execution ─────────────────────────────────────────────────────────────────

export type ShellType = 'bash' | 'zsh' | 'powershell';

export interface ExecOptions {
  shell?: ShellType;
  timeout_ms?: number;
  cwd?: string;
  env?: Record<string, string>;
}

export interface ExecResult {
  exit_code: number;
  stdout: string;
  stderr: string;
  timed_out: boolean;
  duration_ms: number;
}

// ── Policy / Approval ─────────────────────────────────────────────────────────

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface ApprovalToken {
  /** UUID assigned to this approval request. */
  id: string;
  /** Dot-namespaced action string, e.g. "shell.exec". */
  action: string;
  /**
   * SHA-256 (truncated) of action + sorted context, excluding the
   * approval_token key itself. Prevents one token from unlocking a
   * different command than the one that requested approval.
   */
  context_hash: string;
  tier: PolicyTier;
  reason: string;
  status: ApprovalStatus;
  created_at: string;
  expires_at: string;
}

export interface PackageAllowlistEntry {
  /** Package name as used by the package manager (e.g. "lodash", "requests"). */
  name: string;
  /** Package manager identifier: "npm" | "yarn" | "pip" | "apt". */
  manager: string;
  added_at: string;
}

export interface PackageAllowlistFile {
  /**
   * Monotonically increasing version counter.
   * Incremented on every write so change history is traceable.
   */
  version: number;
  updated_at: string;
  entries: PackageAllowlistEntry[];
}

// ── API Response envelope ─────────────────────────────────────────────────────

export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

// ── Audit ─────────────────────────────────────────────────────────────────────

export interface AuditEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  service: string;
  message: string;
  action?: string;
  tier?: PolicyTier;
  prev_hash?: string;
  curr_hash?: string;
  [key: string]: unknown;
}

// ── File Operations ───────────────────────────────────────────────────────────

export type FileOperationType = 'read' | 'write' | 'create' | 'delete' | 'chmod' | 'chown';

export interface WorkspaceRootsFile {
  /**
   * Monotonically increasing version counter.
   * Incremented on every write so change history is traceable.
   */
  version: number;
  updated_at: string;
  /** Absolute paths treated as workspace roots for Tier 1 file ops. */
  roots: string[];
}

export interface FileOpOptions {
  /** For delete — recursively remove directory tree (requires Tier 2 approval). */
  recursive?: boolean;
  /** For chmod — mode string or octal number (e.g. "644", 0o755). */
  mode?: string | number;
  /** For chown — owner name or UID. */
  owner?: string;
  /** For chown — group name or GID. */
  group?: string;
  /** For write/create — file content. */
  content?: string;
  /** For write — encoding (default: utf-8). */
  encoding?: BufferEncoding;
}

export interface FileOpResult {
  success: boolean;
  tier_decision: TierDecision;
  /** Populated for successful read operations. */
  content?: string;
  error?: string;
}

// ── Auth ──────────────────────────────────────────────────────────────────────

export type AuthMethod = 'oauth' | 'device-code' | 'cli-hook' | 'api-key';
export type AuthStatus = 'authenticated' | 'unauthenticated' | 'expired' | 'refreshing';

export interface AuthSession {
  provider: string;
  status: AuthStatus;
  expires_at: string | null;
  auth_method: AuthMethod;
  created_at: string;
}

/** Output contract for: apex auth login --provider <name> --json */
export interface AuthLoginResult {
  status: 'success' | 'failure';
  provider: string;
  expires_at: string | null;
  message: string;
}

export interface ProviderConfig {
  provider: string;
  model: string;
}

// ── Provider Gateway ──────────────────────────────────────────────────────────

export type MessageRole = 'user' | 'assistant' | 'system';

export interface GatewayMessage {
  role: MessageRole;
  content: string;
}

export interface CompletionOptions {
  max_tokens?: number;
  temperature?: number;
  /** Override the model from active session config. */
  model?: string;
}

export interface CompletionResult {
  content: string;
  model: string;
  provider: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

// ── Docker ────────────────────────────────────────────────────────────────────

export type DockerOperationType = 'list' | 'start' | 'stop' | 'build' | 'inspect';

export interface DockerOptions {
  timeout_ms?: number;
  cwd?: string;
  env?: Record<string, string>;
}

export interface DockerBuildOptions extends DockerOptions {
  tag?: string;
  dockerfile?: string;
  buildArgs?: Record<string, string>;
}

export interface DockerResult {
  exit_code: number;
  stdout: string;
  stderr: string;
  timed_out: boolean;
  cancelled: boolean;
  duration_ms: number;
  tier_decision: TierDecision;
}

export interface DockerActiveOperation {
  readonly pid: number;
  readonly operation: DockerOperationType;
  readonly startedAt: string;
  outputRef: string;
  cancelled: boolean;
}

// ── Checkpoint & Crash Recovery ───────────────────────────────────────────────

export type StepStatus = 'pending' | 'in_progress' | 'completed' | 'interrupted' | 'failed';

/**
 * Resumable position marker for a tool that was in-progress when the process crashed.
 * Stored in CheckpointStep.cursor so the tool can resume from its last known position.
 */
export interface ToolCursor {
  /** For log-stream tools: last successfully read line number (0-based). */
  line_position?: number;
  /** For paginated list tools: opaque pagination token from the last page fetched. */
  pagination_token?: string;
  /** For byte-range tools: last successfully read byte offset. */
  byte_offset?: number;
  /** Extension point for tool-specific cursor fields. */
  [key: string]: unknown;
}

/**
 * Reference to a tool output, either inlined (≤ 10 KB) or stored on disk (> 10 KB).
 * The hash field is always present and is verified on recovery via SHA256.
 */
export interface ToolOutputRef {
  /** SHA256 hex digest of the raw UTF-8 output content. */
  hash: string;
  /** Original byte length of the output. */
  size_bytes: number;
  /**
   * Inline content — present only when size_bytes ≤ 10 240 (10 KB).
   * When absent, the content lives at ~/.apex/state/outputs/<hash>.
   */
  inline?: string;
}

/**
 * Approval item re-generated during crash recovery for any Tier 2 step that
 * was in-flight when the process was interrupted.  Must be resolved before
 * the task can resume.
 */
export interface PendingApproval {
  /** ID of the step that was interrupted. */
  step_id: string;
  /** Dot-namespaced action string (mirrors ApprovalToken.action). */
  action: string;
  tier: PolicyTier;
  requested_at: string;
  /** Original approval token ID, if one had been issued before the crash. */
  approval_id?: string;
}

/** Single step within a task, tracked inside a Checkpoint. */
export interface CheckpointStep {
  /** Unique identifier for this step within the task. */
  id: string;
  name: string;
  status: StepStatus;
  tier: PolicyTier;
  started_at?: string;
  completed_at?: string;
  /**
   * Last-known tool cursor for this step.  On recovery, the tool reads this
   * field and resumes from its last position rather than restarting.
   */
  cursor?: ToolCursor;
  /**
   * Key into Checkpoint.tool_outputs_ref for this step's output, if any.
   * Resolves to a ToolOutputRef (inline or on-disk hash).
   */
  output_ref_key?: string;
}

/**
 * Versioned checkpoint persisted to ~/.apex/state/checkpoints/<task_id>.checkpoint.json.
 * Written atomically after every step transition.
 * See PRD §7.2–7.3.
 */
export interface Checkpoint {
  /** Increment when the schema changes.  Currently: 1. */
  schema_version: number;
  task_id: string;
  goal: string;
  /** Zero-based index of the currently active step in `steps`. */
  current_step: number;
  /** Status of the step at `current_step` (denormalised for fast reads). */
  step_status: StepStatus;
  steps: CheckpointStep[];
  /** Approvals that must be re-resolved before the task can resume. */
  pending_approvals: PendingApproval[];
  /**
   * Map of ref-key → ToolOutputRef.
   * Keys are arbitrary strings (typically step IDs or tool call IDs).
   * Large outputs (> 10 KB) reference files on disk; small ones are inlined.
   */
  tool_outputs_ref: Record<string, ToolOutputRef>;
  /** SHA256 hex digest of the active policy-snapshot file at checkpoint time. */
  policy_snapshot_hash: string;
  updated_at: string;
}

// ── Memory Model ──────────────────────────────────────────────────────────────

export type MemoryTier = 'short-term' | 'episodic' | 'durable';
export type UserFeedback = 'thumbs-up' | 'thumbs-down';
export type ContextSegment = 'system_policy' | 'active_task_state' | 'recent_actions' | 'retrieved_memory';
export type ModelSize = 'large' | 'medium' | 'small';

export interface MemoryItem {
  /** UUID for this memory item. */
  id: string;
  tier: MemoryTier;
  /** Text content of the memory item. */
  content: string;
  /** Searchable tags. */
  tags: string[];
  /** Workspace identifier (absolute path or logical name). */
  workspace_id: string;
  /** Session that created this item. */
  session_id: string;
  created_at: string;
  last_accessed_at: string;
  /** Number of times this item has been retrieved. */
  access_count: number;
  /** UTF-8 byte length of content. */
  size_bytes: number;
  /**
   * If true, this item must never be included in LLM prompts or relevance-scored
   * results. The RelevanceScorer filters these out unconditionally.
   */
  sensitive?: boolean;
}

export interface MemoryFeedbackRecord {
  item_id: string;
  session_id: string;
  feedback: UserFeedback;
  timestamp: string;
}

export interface FeedbackFile {
  version: number;
  updated_at: string;
  records: MemoryFeedbackRecord[];
}

/**
 * A memory item that has met the quantitative promotion criteria
 * (≥2 sessions with positive feedback, confidence ≥0.8) and is
 * awaiting explicit user approval before becoming durable.
 */
export interface PromotionCandidate {
  item_id: string;
  /** Number of unique sessions that gave positive feedback. */
  session_count: number;
  /** positive_feedback / total_feedback. Always in [0, 1]. */
  confidence_score: number;
  total_feedback: number;
  positive_feedback: number;
}

export interface EpisodicMemoryFile {
  version: number;
  workspace_id: string;
  /** Sum of size_bytes for all items. */
  total_bytes: number;
  updated_at: string;
  items: MemoryItem[];
}

export interface DurableMemoryFile {
  version: number;
  updated_at: string;
  items: MemoryItem[];
}

// ── Context Budget ─────────────────────────────────────────────────────────────

export interface BudgetSegmentAllocation {
  /** Percentage of usable_tokens allocated to this segment. */
  percent: number;
  /** Absolute token ceiling for this segment. */
  tokens: number;
}

export interface ContextBudgetAllocation {
  /** Full context window of the model. */
  total_context_window: number;
  /** Tokens available after scaling (1.0, 0.75, or 0.50). */
  usable_tokens: number;
  model_size: ModelSize;
  system_policy: BudgetSegmentAllocation;
  active_task_state: BudgetSegmentAllocation;
  recent_actions: BudgetSegmentAllocation;
  retrieved_memory: BudgetSegmentAllocation;
}

export interface ModelProfileOverrides {
  system_policy_pct?: number;
  active_task_state_pct?: number;
  recent_actions_pct?: number;
  retrieved_memory_pct?: number;
}

export interface ModelProfile {
  model_id: string;
  context_window: number;
  budget_overrides?: ModelProfileOverrides;
}

export interface ModelProfilesFile {
  version: number;
  updated_at: string;
  /** Key: model_id */
  profiles: Record<string, ModelProfile>;
}

/**
 * Result of chunking a large tool output for prompt context.
 * Only the first/last 500 tokens are kept in the prompt; the full
 * content is stored on disk and referenced by SHA256 hash.
 */
export interface ToolOutputChunk {
  /** Prompt-safe content: first 500 + last 500 tokens. */
  prompt_content: string;
  /** Full output stored via OutputStore (SHA256-referenced). */
  full_ref: ToolOutputRef;
  /** True when content exceeded the 1000-token prompt threshold. */
  was_chunked: boolean;
}

// ── Tool Catalog (JAL-012) ────────────────────────────────────────────────────

/**
 * Structured result returned by every tool execution.
 * Compatible with GoalLoop step output.
 */
export interface ToolResult {
  /** Tool name (e.g. "file:read", "process:kill"). */
  tool: string;
  /** Arguments passed to the tool. */
  args: string[];
  /** Tier that was enforced for this invocation. */
  tier: PolicyTier;
  /** Exit code: 0 = success, non-zero = failure. */
  exit_code: number;
  stdout: string;
  stderr: string;
  duration_ms: number;
}

/**
 * Contract every tool in the catalog must implement.
 * Tools delegate execution to ShellEngine or PolicyFileOps — never spawn directly.
 */
export interface ITool {
  /** Short dot-namespaced name used as tool identifier (e.g. "file:read"). */
  readonly name: string;
  /** One-line description injected into the GoalLoop LLM prompt. */
  readonly description: string;
  /** Default tier for catalog display (actual tier enforced at classify() time). */
  readonly tier: PolicyTier;
  execute(args: string[]): Promise<ToolResult>;
}

// ── Canvas Events (JAL-013) ───────────────────────────────────────────────────

/**
 * Event types streamed over the Canvas WebSocket connection.
 * Matches PRD §14.2 outbound event type enumeration.
 */
export type CanvasEventType =
  | 'system.status'
  | 'command.output'
  | 'approval.requested'
  | 'approval.resolved'
  | 'heartbeat.pulse'
  | 'task.started'
  | 'task.completed'
  | 'task.failed';

/**
 * Outbound envelope for all Canvas WebSocket events (PRD §14.2).
 * Every event published by ApexRuntime → EventBus → CanvasServer uses this shape.
 */
export interface CanvasEvent {
  /** UUID for this event instance. */
  event_id: string;
  event_type: CanvasEventType;
  /** Associated task ID, or null for system-level events. */
  task_id: string | null;
  /** Policy tier relevant to this event, or null. */
  tier: PolicyTier | null;
  created_at: string;
  /** Event-specific data. Must never contain credentials, tokens, or raw secrets. */
  payload: Record<string, unknown>;
}

// ── Goal Loop (JAL-011) ───────────────────────────────────────────────────────

export type GoalStepTool = 'shell' | 'docker' | 'fileops';

/**
 * A single step within a GoalLoop execution.
 * Decomposed from a natural-language goal by the LLM, then executed sequentially.
 */
export interface GoalStep {
  /** Unique identifier within this goal run (e.g. "step-1"). */
  id: string;
  /** Human-readable description of what this step does. */
  description: string;
  /** Shell command (or tool-specific arg string) to execute. */
  command: string;
  /** Which execution tool handles this step. */
  tool: GoalStepTool;
  /** Tier determined by TieredFirewall pre-classification. Default 1 before classification. */
  tier: PolicyTier;
  status: StepStatus;
  /** Combined stdout+stderr captured during execution. */
  output: string;
  /** Last error message if the step failed. */
  error: string;
}

// ── Environment Snapshot (JAL-010) ────────────────────────────────────────────

export interface ProcessInfo {
  pid: number;
  /** Process command name. */
  name: string;
  /** CPU usage percentage at snapshot time. */
  cpu_percent: number;
  /** Memory usage percentage at snapshot time. */
  mem_percent: number;
  /** Process status string (R, S, D, Z, T). */
  status: string;
}

export interface ContainerState {
  id: string;
  name: string;
  /** Full status string from docker ps (e.g. "Up 2 hours", "Exited (0) 3 min ago"). */
  status: string;
}

export interface DiskMount {
  mount: string;
  total_bytes: number;
  used_bytes: number;
  avail_bytes: number;
  /** Usage as a percentage 0–100. */
  use_percent: number;
}

export interface NetworkConnection {
  proto: string;
  local_addr: string;
  foreign_addr: string;
  state: string;
}

export interface EnvironmentSnapshot {
  captured_at: string;
  processes: ProcessInfo[];
  containers: ContainerState[];
  disk_mounts: DiskMount[];
  /** Available RAM in megabytes. */
  available_memory_mb: number;
  network_connections: NetworkConnection[];
}

export type ChangeClassification = 'routine' | 'notable' | 'urgent';

export interface EnvironmentDelta {
  /** Short machine-readable field identifier (e.g. "disk:/", "memory", "container:nginx"). */
  field: string;
  classification: ChangeClassification;
  /** Human-readable description of the change. Never includes raw command output. */
  description: string;
  prev_value?: unknown;
  curr_value?: unknown;
}

export interface SnapshotDelta {
  timestamp: string;
  deltas: EnvironmentDelta[];
  has_urgent: boolean;
  has_notable: boolean;
}

// ── Heartbeat & Playbooks ─────────────────────────────────────────────────────

export type PlaybookTriggerType =
  | 'high_disk_pressure'
  | 'service_down'
  | 'memory_pressure'
  | 'failed_task'
  | 'custom';

export interface PlaybookTrigger {
  type: PlaybookTriggerType;
  /** For service_down: the service/command to probe. */
  service?: string;
  /** For custom: a shell test expression (evaluated with bash -c). */
  expression?: string;
}

export interface PlaybookStep {
  name: string;
  command: string;
  /** Per-step timeout in seconds (default: max_runtime). */
  timeout?: number;
}

export type RollbackFailurePolicy = 'degrade' | 'ignore' | 'alert';

export interface PlaybookDefinition {
  name: string;
  description: string;
  /** staging=true → queued for operator review; staging=false → eligible for execution. */
  staging: boolean;
  triggers: PlaybookTrigger[];
  steps: PlaybookStep[];
  /** Maximum total runtime in seconds across all steps. */
  max_runtime: number;
  rollback_commands: string[];
  rollback_failure_policy: RollbackFailurePolicy;
}

export interface PlaybookHealthEntry {
  playbook: string;
  degraded: boolean;
  degraded_at?: string;
  degraded_reason?: string;
  last_run?: string;
  last_exit_code?: number;
}

export interface PlaybookHealthFile {
  version: number;
  updated_at: string;
  playbooks: Record<string, PlaybookHealthEntry>;
}

export type HeartbeatCheckType =
  | 'disk_pressure'
  | 'process_health'
  | 'container_status'
  | 'failed_job'
  | 'playbook_execution';

export interface HeartbeatCheckResult {
  check: HeartbeatCheckType | string;
  healthy: boolean;
  exit_code: number;
  output: string;
  checked_at: string;
  metadata?: Record<string, unknown>;
}

export interface HeartbeatCycleResult {
  cycle_at: string;
  checks: HeartbeatCheckResult[];
  playbooks_triggered: string[];
  playbooks_staged: string[];
  errors: string[];
}

// ── Plugin Coordinator (JAL-016) ─────────────────────────────────────────────

/**
 * Redaction level applied to outbound plugin events.
 * 'standard' omits code snippets, file paths, and env var names.
 * 'full' strips all content — only structural metadata is visible.
 */
export type RedactionLevel = 'standard' | 'full' | 'none';

/**
 * Outbound plugin event envelope (PRD §14.2).
 * Extends the CanvasEvent shape with plugin-specific fields.
 */
export interface PluginEvent {
  event_id: string;
  event_type: CanvasEventType;
  workspace_id: string;
  task_id: string | null;
  tier: PolicyTier | null;
  created_at: string;
  payload: Record<string, unknown>;
  redaction_level: RedactionLevel;
  /** HMAC-SHA256 signature over canonical JSON of all other fields. */
  signature: string;
}

/**
 * An inbound action arriving from a chat platform (Slack/Telegram) to
 * the plugin coordinator queue.
 */
export interface InboundAction {
  action_id: string;
  workspace_id: string;
  /** 'approve' | 'deny' are the two approval responses. */
  action_type: 'approve' | 'deny';
  /** Platform-specific actor identifier (Slack user ID, Telegram user ID, etc.). */
  actor_platform_id: string;
  /** Which plugin sent this action (e.g. 'slack', 'telegram'). */
  plugin_name: string;
  /** The approval_id this action targets (matches PluginApprovalToken.approval_id). */
  approval_id: string;
  /**
   * The PluginApprovalToken.token_id issued when the approval button was sent.
   * Used by consumeToken() to validate the single-use approval gate.
   */
  token: string;
  /**
   * HMAC-SHA256 signature of this action (all fields except signature itself).
   * Used to verify the relay is authorized and the payload was not tampered.
   */
  signature: string;
  received_at: string;
}

/**
 * Single-use approval token for plugin-based approvals.
 * Bound to workspace_id + approval_id.
 * TTL: 10 minutes. Invalidated on first use or expiry.
 */
export interface PluginApprovalToken {
  token_id: string;
  approval_id: string;
  workspace_id: string;
  expires_at: string;
  used: boolean;
  created_at: string;
}

/**
 * Mapping entry from a platform actor identity to a local Apex identity.
 * Stored in ~/.apex/config/plugin-actors.json.
 */
export interface PluginActorEntry {
  /** Platform identifier — Slack user ID ('U12345') or Telegram user ID (numeric string). */
  platform_id: string;
  plugin_name: string;
  /** Local Apex identity label (e.g. 'kirk', 'operator'). */
  apex_identity: string;
}

/** Shape of ~/.apex/config/plugin-actors.json */
export interface PluginActorMap {
  version: number;
  actors: PluginActorEntry[];
}

/**
 * IPlugin — contract every chat platform adapter must satisfy.
 */
export interface IPlugin {
  readonly name: string;
  /** Send an outbound event to the platform (e.g. post an approval request). */
  send(event: PluginEvent): Promise<void>;
  /**
   * Poll for inbound actions from the platform.
   * Returns any new actions collected since the last poll.
   */
  poll(): Promise<InboundAction[]>;
  /** Disconnect: stop polling, cancel any in-flight network requests. */
  disconnect(): void;
}
