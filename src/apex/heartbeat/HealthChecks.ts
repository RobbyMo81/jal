// Co-authored by FORGE (Session: forge-20260325062232-1899997)
// src/apex/heartbeat/HealthChecks.ts — Read-only heartbeat health checks
//
// All checks are non-destructive: they observe system state but never modify it.
// Each check returns a HeartbeatCheckResult (healthy/unhealthy, exit_code, output).
//
// Disk pressure uses a sustained-threshold model: the 'high_disk_pressure' trigger
// fires only when the root filesystem has been ≥85% for ≥5 minutes (tracked across
// scheduler cycles via in-memory state).
//
// IHeartbeatShell is injected so tests can control command output without spawning
// real processes.

import { HeartbeatCheckResult } from '../types';

// ── IHeartbeatShell ───────────────────────────────────────────────────────────

export interface ShellExecResult {
  exit_code: number;
  stdout: string;
  stderr: string;
}

/** Minimal shell interface for heartbeat health checks. */
export interface IHeartbeatShell {
  exec(cmd: string, timeoutMs?: number): ShellExecResult;
}

// ── DiskPressureTracker ───────────────────────────────────────────────────────

/** Tracks when disk pressure was first observed above threshold. */
export class DiskPressureTracker {
  private firstHighAt: number | null = null;

  /**
   * Call with the current disk usage percent (0–100).
   * Returns true only when usage ≥ threshold sustained for ≥ sustainMs.
   */
  update(usagePercent: number, threshold = 85, sustainMs = 5 * 60 * 1000): boolean {
    const now = Date.now();
    if (usagePercent >= threshold) {
      if (this.firstHighAt === null) {
        this.firstHighAt = now;
      }
      return now - this.firstHighAt >= sustainMs;
    }
    // Pressure relieved — reset
    this.firstHighAt = null;
    return false;
  }

  /** Exposed for testing: the timestamp (ms) when pressure was first seen. */
  get firstHighTimestamp(): number | null {
    return this.firstHighAt;
  }

  /** Inject a past start time (for testing sustained logic). */
  setFirstHighAt(ts: number | null): void {
    this.firstHighAt = ts;
  }
}

// ── HealthChecks ─────────────────────────────────────────────────────────────

export class HealthChecks {
  readonly diskTracker: DiskPressureTracker;

  constructor(
    private readonly shell: IHeartbeatShell,
    diskTracker?: DiskPressureTracker,
  ) {
    this.diskTracker = diskTracker ?? new DiskPressureTracker();
  }

  // ── Process health ──────────────────────────────────────────────────────────

  checkProcessHealth(): HeartbeatCheckResult {
    const checked_at = new Date().toISOString();
    try {
      const r = this.shell.exec('ps aux --no-headers | wc -l', 5_000);
      const processCount = parseInt(r.stdout.trim(), 10);
      return {
        check: 'process_health',
        healthy: r.exit_code === 0 && processCount > 0,
        exit_code: r.exit_code,
        output: r.stdout.trim(),
        checked_at,
        metadata: { process_count: isNaN(processCount) ? 0 : processCount },
      };
    } catch (e) {
      return {
        check: 'process_health',
        healthy: false,
        exit_code: 1,
        output: (e as Error).message,
        checked_at,
      };
    }
  }

  // ── Disk pressure ───────────────────────────────────────────────────────────

  /**
   * Checks root filesystem usage.
   * healthy=true means disk is fine (no trigger).
   * metadata.triggered=true means sustained high disk pressure — callers should
   * fire the high_disk_pressure playbook trigger.
   */
  checkDiskPressure(): HeartbeatCheckResult {
    const checked_at = new Date().toISOString();
    try {
      const r = this.shell.exec("df -h / | awk 'NR==2 {print $5}'", 5_000);
      if (r.exit_code !== 0) {
        return {
          check: 'disk_pressure',
          healthy: false,
          exit_code: r.exit_code,
          output: r.stderr || r.stdout,
          checked_at,
        };
      }
      const raw = r.stdout.trim().replace('%', '');
      const usagePercent = parseInt(raw, 10);
      const triggered = this.diskTracker.update(usagePercent);
      return {
        check: 'disk_pressure',
        healthy: usagePercent < 85,
        exit_code: 0,
        output: `${usagePercent}%`,
        checked_at,
        metadata: { usage_percent: usagePercent, triggered },
      };
    } catch (e) {
      return {
        check: 'disk_pressure',
        healthy: false,
        exit_code: 1,
        output: (e as Error).message,
        checked_at,
      };
    }
  }

  // ── Container status ────────────────────────────────────────────────────────

  /**
   * Lists running Docker containers.
   * unhealthy if the docker daemon is unreachable (non-zero exit).
   */
  checkContainerStatus(): HeartbeatCheckResult {
    const checked_at = new Date().toISOString();
    try {
      const r = this.shell.exec('docker ps --format "{{.Names}}\t{{.Status}}"', 10_000);
      return {
        check: 'container_status',
        healthy: r.exit_code === 0,
        exit_code: r.exit_code,
        output: r.stdout.trim(),
        checked_at,
        metadata: { container_count: r.stdout.trim() ? r.stdout.trim().split('\n').length : 0 },
      };
    } catch (e) {
      return {
        check: 'container_status',
        healthy: false,
        exit_code: 1,
        output: (e as Error).message,
        checked_at,
      };
    }
  }

  // ── Memory pressure ─────────────────────────────────────────────────────────

  /**
   * Checks available RAM (Linux /proc/meminfo).
   * metadata.triggered=true when available < 512 MB.
   */
  checkMemoryPressure(): HeartbeatCheckResult {
    const checked_at = new Date().toISOString();
    try {
      const r = this.shell.exec(
        "awk '/MemAvailable/ {print $2}' /proc/meminfo",
        5_000,
      );
      if (r.exit_code !== 0) {
        return {
          check: 'process_health',
          healthy: false,
          exit_code: r.exit_code,
          output: r.stderr || r.stdout,
          checked_at,
        };
      }
      const availableKb = parseInt(r.stdout.trim(), 10);
      const availableMb = isNaN(availableKb) ? 0 : Math.floor(availableKb / 1024);
      const triggered = availableMb < 512;
      return {
        check: 'process_health',
        healthy: !triggered,
        exit_code: 0,
        output: `${availableMb} MB available`,
        checked_at,
        metadata: { available_mb: availableMb, triggered },
      };
    } catch (e) {
      return {
        check: 'process_health',
        healthy: false,
        exit_code: 1,
        output: (e as Error).message,
        checked_at,
      };
    }
  }

  // ── Failed job detection ────────────────────────────────────────────────────

  /**
   * Scans ~/.apex/state/jobs.json for tasks marked failed with no retry in-flight.
   * If the file is absent, returns healthy (no jobs → no failures).
   */
  checkFailedJobs(jobsFilePath?: string): HeartbeatCheckResult {
    const checked_at = new Date().toISOString();
    const path = jobsFilePath ?? `${process.env.HOME ?? '~'}/.apex/state/jobs.json`;
    try {
      const r = this.shell.exec(
        `[ -f "${path}" ] && cat "${path}" || echo '{"jobs":[]}'`,
        5_000,
      );
      if (r.exit_code !== 0) {
        return {
          check: 'failed_job',
          healthy: true, // no file = no failed jobs
          exit_code: 0,
          output: 'jobs file not present',
          checked_at,
        };
      }
      let data: { jobs?: Array<{ status: string; retry_in_flight?: boolean }> };
      try {
        data = JSON.parse(r.stdout.trim());
      } catch {
        return {
          check: 'failed_job',
          healthy: true,
          exit_code: 0,
          output: 'jobs file unreadable — treating as no failures',
          checked_at,
        };
      }
      const failedNoRetry = (data.jobs ?? []).filter(
        (j) => j.status === 'failed' && !j.retry_in_flight,
      );
      return {
        check: 'failed_job',
        healthy: failedNoRetry.length === 0,
        exit_code: 0,
        output: failedNoRetry.length > 0
          ? `${failedNoRetry.length} failed job(s) with no retry`
          : 'no failed jobs',
        checked_at,
        metadata: { failed_count: failedNoRetry.length, triggered: failedNoRetry.length > 0 },
      };
    } catch (e) {
      return {
        check: 'failed_job',
        healthy: true,
        exit_code: 0,
        output: `check error (treated as healthy): ${(e as Error).message}`,
        checked_at,
      };
    }
  }
}

// ── ExecSyncShell (real impl) ─────────────────────────────────────────────────

import { execSync } from 'child_process';

/** Production shell implementation using execSync (synchronous, short timeout). */
export class ExecSyncShell implements IHeartbeatShell {
  exec(cmd: string, timeoutMs = 10_000): ShellExecResult {
    try {
      const stdout = execSync(cmd, {
        timeout: timeoutMs,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { exit_code: 0, stdout: stdout ?? '', stderr: '' };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; status?: number; signal?: string };
      return {
        exit_code: typeof e.status === 'number' ? e.status : 1,
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? (e.signal ? `killed by ${e.signal}` : String(err)),
      };
    }
  }
}
