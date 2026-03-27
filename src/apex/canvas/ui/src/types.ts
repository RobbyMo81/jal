// Co-authored by FORGE (Session: forge-20260327063704-3049883)
// src/apex/canvas/ui/src/types.ts — JAL-014 Canvas Frontend shared types
// Mirrors relevant backend types from src/apex/types/index.ts

export type CanvasEventType =
  | 'system.status'
  | 'command.output'
  | 'approval.requested'
  | 'approval.resolved'
  | 'heartbeat.pulse'
  | 'task.started'
  | 'task.completed'
  | 'task.failed';

export interface CanvasEvent {
  event_id: string;
  event_type: CanvasEventType;
  task_id: string | null;
  tier: number | null;
  created_at: string;
  payload: Record<string, unknown>;
}

// ── system.status payload ─────────────────────────────────────────────────────

export interface ProcessInfo {
  pid: number;
  name: string;
  cpu_percent: number;
  mem_percent: number;
  status: string;
}

export interface ContainerState {
  id: string;
  name: string;
  status: string;
}

export interface DiskMount {
  mount: string;
  total_bytes: number;
  used_bytes: number;
  avail_bytes: number;
  use_percent: number;
}

export interface SystemStatusPayload {
  captured_at: string;
  processes: ProcessInfo[];
  containers: ContainerState[];
  disk_mounts: DiskMount[];
  available_memory_mb: number;
}

// ── command.output payload ────────────────────────────────────────────────────

export interface CommandOutputPayload {
  task_id: string;
  chunk: string;
}

// ── approval.requested payload ────────────────────────────────────────────────

export interface ApprovalRequestedPayload {
  approval_id: string;
  action: string;
  reason: string;
  tier: number;
}

// ── heartbeat.pulse payload ───────────────────────────────────────────────────

export interface HeartbeatPulsePayload {
  timestamp: string;
  narrative?: string;
  deltas?: HeartbeatDelta[];
}

export interface HeartbeatDelta {
  field: string;
  classification: 'routine' | 'notable' | 'urgent';
  description: string;
}

// ── Memory API responses ──────────────────────────────────────────────────────

export interface EpisodicEntry {
  id: string;
  workspace_id: string;
  content: string;
  tags: string[];
  created_at: string;
  accessed_at: string;
}

export interface DurableEntry {
  key: string;
  value: string;
  created_at: string;
  updated_at: string;
}

// ── Connection state ──────────────────────────────────────────────────────────

export type ConnectionStatus = 'connected' | 'reconnecting' | 'disconnected';
