// src/apex/types.ts
// Global types for Apex

export interface CompletionResult {
  text: string;
  // Other potential fields like tokens, finish_reason, etc.
}

export interface EnvironmentSnapshot {
  captured_at: string;
  processes: ProcessInfo[];
  containers: ContainerState[];
  disk_mounts: DiskMount[];
  available_memory_mb: number;
  network_connections: NetworkConnection[];
}

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

export interface NetworkConnection {
  proto: string;
  local_addr: string;
  foreign_addr: string;
  state: string;
}

export interface AuditEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  action: string;
  message?: string;
  details?: Record<string, unknown>;
  prev_hash: string;
  curr_hash: string;
}
