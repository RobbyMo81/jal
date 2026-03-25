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
