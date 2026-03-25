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
