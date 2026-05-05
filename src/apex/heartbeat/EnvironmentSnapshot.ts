// Co-authored by FORGE (Session: forge-20260326221916-3025550)
// src/apex/heartbeat/EnvironmentSnapshot.ts — JAL-010 Environment Snapshot Collector
//
// Read-only system observer. Collects a point-in-time snapshot of:
//   - Running processes (PID, name, CPU%, MEM%, status)
//   - Container states (ID, name, status)
//   - Disk usage per mount (total, used, avail, use%)
//   - Available memory in MB
//   - Active network connections (protocol, local, foreign, state)
//
// SAFETY GATE: this module is strictly read-only. No writes to system state.

import { IHeartbeatShell } from './HealthChecks';
import {
  EnvironmentSnapshot,
  ProcessInfo,
  ContainerState,
  DiskMount,
  NetworkConnection,
} from '../../src/apex/types';

// ── SnapshotCollector ─────────────────────────────────────────────────────────

export class SnapshotCollector {
  constructor(private readonly shell: IHeartbeatShell) {}

  /** Collect a full environment snapshot. All operations are read-only. */
  collect(): EnvironmentSnapshot {
    return {
      captured_at: new Date().toISOString(),
      processes: this.collectProcesses(),
      containers: this.collectContainers(),
      disk_mounts: this.collectDiskMounts(),
      available_memory_mb: this.collectAvailableMemoryMb(),
      network_connections: this.collectNetworkConnections(),
    };
  }

  // ── Processes ───────────────────────────────────────────────────────────────

  /**
   * Parse `ps aux --no-headers` output into ProcessInfo records.
   * Columns: USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND
   */
  collectProcesses(): ProcessInfo[] {
    try {
      const r = this.shell.exec('ps aux --no-headers', 8_000);
      if (r.exit_code !== 0 || !r.stdout.trim()) return [];
      return r.stdout
        .trim()
        .split('
')
        .map((line) => this.parseProcessLine(line))
        .filter((p): p is ProcessInfo => p !== null);
    } catch {
      return [];
    }
  }

  private parseProcessLine(line: string): ProcessInfo | null {
    // Split on whitespace, rejoin COMMAND (everything from col 10 onward)
    const parts = line.trim().split(/\s+/);
    if (parts.length < 11) return null;
    const pid = parseInt(parts[1]!, 10);
    const cpu = parseFloat(parts[2]!);
    const mem = parseFloat(parts[3]!);
    const status = parts[7] ?? 'S';
    // Command name: first token of the full command (no path)
    const rawCmd = parts.slice(10).join(' ');
    const name = rawCmd.split(/\s+/)[0]!.replace(/^.*\//, '').slice(0, 64);
    if (isNaN(pid)) return null;
    return {
      pid,
      name,
      cpu_percent: isNaN(cpu) ? 0 : cpu,
      mem_percent: isNaN(mem) ? 0 : mem,
      status,
    };
  }

  // ── Containers ──────────────────────────────────────────────────────────────

  /** Parse `docker ps -a --format ...` into ContainerState records. */
  collectContainers(): ContainerState[] {
    try {
      const r = this.shell.exec(
        'docker ps -a --format "{{.ID}}	{{.Names}}	{{.Status}}"',
        10_000,
      );
      if (r.exit_code !== 0 || !r.stdout.trim()) return [];
      return r.stdout
        .trim()
        .split('
')
        .map((line) => {
          const [id, name, ...statusParts] = line.split('	');
          if (!id || !name) return null;
          return { id: id.trim(), name: name.trim(), status: statusParts.join('	').trim() };
        })
        .filter((c): c is ContainerState => c !== null);
    } catch {
      return [];
    }
  }

  // ── Disk mounts ─────────────────────────────────────────────────────────────

  /**
   * Parse `df -k` output into DiskMount records.
   * Columns: Filesystem 1K-blocks Used Available Use% Mounted-on
   */
  collectDiskMounts(): DiskMount[] {
    try {
      const r = this.shell.exec('df -k', 5_000);
      if (r.exit_code !== 0 || !r.stdout.trim()) return [];
      const lines = r.stdout.trim().split('
').slice(1); // skip header
      const mounts: DiskMount[] = [];
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        // Handle wrapped lines (df wraps when filesystem name is very long)
        if (parts.length < 6) continue;
        const total_bytes = parseInt(parts[1]!, 10) * 1024;
        const used_bytes = parseInt(parts[2]!, 10) * 1024;
        const avail_bytes = parseInt(parts[3]!, 10) * 1024;
        const use_pct_raw = parts[4]!.replace('%', '');
        const use_percent = parseInt(use_pct_raw, 10);
        const mount = parts[5]!;
        if (isNaN(total_bytes) || isNaN(use_percent)) continue;
        mounts.push({ mount, total_bytes, used_bytes, avail_bytes, use_percent });
      }
      return mounts;
    } catch {
      return [];
    }
  }

  // ── Memory ──────────────────────────────────────────────────────────────────

  /** Read MemAvailable from /proc/meminfo and return as MB. */
  collectAvailableMemoryMb(): number {
    try {
      const r = this.shell.exec("awk '/MemAvailable/ {print $2}' /proc/meminfo", 5_000);
      if (r.exit_code !== 0) return -1;
      const kb = parseInt(r.stdout.trim(), 10);
      return isNaN(kb) ? -1 : Math.floor(kb / 1024);
    } catch {
      return -1;
    }
  }

  // ── Network connections ─────────────────────────────────────────────────────

  /**
   * Parse `ss -tn` (or fallback `netstat -tn`) output.
   * ss -tn columns: State RecvQ SendQ Local-Addr:Port Peer-Addr:Port
   */
  collectNetworkConnections(): NetworkConnection[] {
    try {
      // Try ss first (modern Linux), fallback to netstat
      const r = this.shell.exec('ss -tn 2>/dev/null || netstat -tn 2>/dev/null', 8_000);
      if (r.exit_code !== 0 || !r.stdout.trim()) return [];
      return this.parseSsOutput(r.stdout);
    } catch {
      return [];
    }
  }

  private parseSsOutput(output: string): NetworkConnection[] {
    const lines = output.trim().split('
');
    const conns: NetworkConnection[] = [];
    for (const line of lines) {
      const t = line.trim();
      // Skip header lines
      if (t.startsWith('State') || t.startsWith('Proto') || !t) continue;
      const parts = t.split(/\s+/);
      // ss -tn: State RecvQ SendQ Local Peer
      if (parts.length >= 5 && parts[0] !== undefined && parts[3] !== undefined && parts[4] !== undefined) {
        conns.push({
          proto: 'tcp',
          local_addr: parts[3],
          foreign_addr: parts[4],
          state: parts[0],
        });
      }
    }
    return conns;
  }
}
