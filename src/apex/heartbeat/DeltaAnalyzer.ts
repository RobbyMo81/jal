// Co-authored by FORGE (Session: forge-20260326221916-3025550)
// src/apex/heartbeat/DeltaAnalyzer.ts — JAL-010 Environment Delta Analyzer
//
// Compares two consecutive EnvironmentSnapshots and classifies each change as:
//   routine  — expected, healthy, no action needed (audit log only)
//   notable  — worth surfacing at session start (written to episodic memory)
//   urgent   — requires immediate escalation (posted to message bus)
//
// Thresholds per Behavior.md:
//   Urgent:  mandatory service down, disk >= 85%, available memory < 512 MB,
//            anomalous CPU (> 90%) or memory (> 80%) on any process
//   Notable: service restarted, disk climbed > 5% since last pulse,
//            new process appeared, container exited cleanly
//   Routine: everything else (container running as expected, disk stable,
//            processes healthy)

import {
  EnvironmentSnapshot,
  EnvironmentDelta,
  SnapshotDelta,
  ChangeClassification,
} from '../types';

// ── Thresholds (mirror Behavior.md) ──────────────────────────────────────────

export const DISK_URGENT_PCT = 85;
export const DISK_NOTABLE_DELTA_PCT = 5;
export const MEMORY_URGENT_MB = 512;
export const CPU_ANOMALOUS_PCT = 90;
export const MEM_ANOMALOUS_PCT = 80;

// ── DeltaAnalyzer ─────────────────────────────────────────────────────────────

export class DeltaAnalyzer {
  /**
   * Compare prev and curr snapshots and return a classified delta set.
   * If prev is null (first pulse), returns an empty delta with no changes.
   */
  analyze(prev: EnvironmentSnapshot | null, curr: EnvironmentSnapshot): SnapshotDelta {
    const deltas: EnvironmentDelta[] = [];

    if (prev !== null) {
      deltas.push(...this.analyzeDisk(prev, curr));
      deltas.push(...this.analyzeMemory(prev, curr));
      deltas.push(...this.analyzeContainers(prev, curr));
      deltas.push(...this.analyzeProcesses(prev, curr));
    }

    return {
      timestamp: curr.captured_at,
      deltas,
      has_urgent: deltas.some((d) => d.classification === 'urgent'),
      has_notable: deltas.some((d) => d.classification === 'notable'),
    };
  }

  // ── Disk analysis ───────────────────────────────────────────────────────────

  private analyzeDisk(prev: EnvironmentSnapshot, curr: EnvironmentSnapshot): EnvironmentDelta[] {
    const deltas: EnvironmentDelta[] = [];
    const prevMounts = new Map(prev.disk_mounts.map((m) => [m.mount, m]));

    for (const mount of curr.disk_mounts) {
      const prevMount = prevMounts.get(mount.mount);
      let classification: ChangeClassification;
      let description: string;

      if (mount.use_percent >= DISK_URGENT_PCT) {
        classification = 'urgent';
        description = `Disk ${mount.mount} at ${mount.use_percent}% (>= ${DISK_URGENT_PCT}% threshold)`;
      } else if (prevMount !== undefined) {
        const delta = mount.use_percent - prevMount.use_percent;
        if (delta >= DISK_NOTABLE_DELTA_PCT) {
          classification = 'notable';
          description = `Disk ${mount.mount} grew ${delta}% (${prevMount.use_percent}% → ${mount.use_percent}%)`;
        } else {
          classification = 'routine';
          description = `Disk ${mount.mount} stable at ${mount.use_percent}%`;
        }
      } else {
        // New mount appeared
        classification = 'notable';
        description = `New mount ${mount.mount} at ${mount.use_percent}%`;
      }

      deltas.push({
        field: `disk:${mount.mount}`,
        classification,
        description,
        prev_value: prevMount?.use_percent,
        curr_value: mount.use_percent,
      });
    }

    return deltas;
  }

  // ── Memory analysis ─────────────────────────────────────────────────────────

  private analyzeMemory(prev: EnvironmentSnapshot, curr: EnvironmentSnapshot): EnvironmentDelta[] {
    const avail = curr.available_memory_mb;
    if (avail < 0) return []; // unavailable

    const prevAvail = prev.available_memory_mb;
    let classification: ChangeClassification;
    let description: string;

    if (avail < MEMORY_URGENT_MB) {
      classification = 'urgent';
      description = `Available memory critically low: ${avail} MB (< ${MEMORY_URGENT_MB} MB threshold)`;
    } else if (prevAvail >= 0 && prevAvail - avail > 256) {
      // Dropped more than 256 MB since last pulse
      classification = 'notable';
      description = `Available memory dropped: ${prevAvail} MB → ${avail} MB`;
    } else {
      classification = 'routine';
      description = `Memory healthy: ${avail} MB available`;
    }

    return [
      {
        field: 'memory',
        classification,
        description,
        prev_value: prevAvail >= 0 ? prevAvail : undefined,
        curr_value: avail,
      },
    ];
  }

  // ── Container analysis ──────────────────────────────────────────────────────

  private analyzeContainers(
    prev: EnvironmentSnapshot,
    curr: EnvironmentSnapshot,
  ): EnvironmentDelta[] {
    const deltas: EnvironmentDelta[] = [];
    const prevByName = new Map(prev.containers.map((c) => [c.name, c]));
    const currByName = new Map(curr.containers.map((c) => [c.name, c]));

    // Check for state changes on known containers
    for (const [name, currC] of currByName) {
      const prevC = prevByName.get(name);
      if (!prevC) {
        // New container appeared
        deltas.push({
          field: `container:${name}`,
          classification: 'notable',
          description: `Container ${name} appeared with status: ${currC.status}`,
          curr_value: currC.status,
        });
        continue;
      }

      const prevRunning = this.isRunning(prevC.status);
      const currRunning = this.isRunning(currC.status);

      if (prevRunning && !currRunning) {
        // Was running, now stopped — classify by whether it exited cleanly
        const exitedCleanly = /Exited \(0\)/.test(currC.status);
        const classification: ChangeClassification = exitedCleanly ? 'notable' : 'urgent';
        deltas.push({
          field: `container:${name}`,
          classification,
          description: exitedCleanly
            ? `Container ${name} exited cleanly (status: ${currC.status})`
            : `Container ${name} stopped unexpectedly (status: ${currC.status})`,
          prev_value: prevC.status,
          curr_value: currC.status,
        });
      } else if (!prevRunning && currRunning) {
        // Was stopped, now running — service recovery
        deltas.push({
          field: `container:${name}`,
          classification: 'notable',
          description: `Container ${name} restarted (now: ${currC.status})`,
          prev_value: prevC.status,
          curr_value: currC.status,
        });
      } else if (prevC.status !== currC.status) {
        // Status text changed but running state same (e.g. uptime counter)
        deltas.push({
          field: `container:${name}`,
          classification: 'routine',
          description: `Container ${name} status updated (${currC.status})`,
          prev_value: prevC.status,
          curr_value: currC.status,
        });
      }
    }

    // Containers that disappeared entirely
    for (const [name, prevC] of prevByName) {
      if (!currByName.has(name)) {
        deltas.push({
          field: `container:${name}`,
          classification: 'notable',
          description: `Container ${name} removed (was: ${prevC.status})`,
          prev_value: prevC.status,
          curr_value: undefined,
        });
      }
    }

    return deltas;
  }

  // ── Process analysis ────────────────────────────────────────────────────────

  private analyzeProcesses(
    prev: EnvironmentSnapshot,
    curr: EnvironmentSnapshot,
  ): EnvironmentDelta[] {
    const deltas: EnvironmentDelta[] = [];
    const prevPids = new Set(prev.processes.map((p) => p.pid));

    // New processes (not in previous snapshot)
    for (const proc of curr.processes) {
      if (!prevPids.has(proc.pid)) {
        deltas.push({
          field: `process:${proc.name}:${proc.pid}`,
          classification: 'notable',
          description: `New process detected: ${proc.name} (PID ${proc.pid})`,
          curr_value: { pid: proc.pid, cpu: proc.cpu_percent, mem: proc.mem_percent },
        });
      }
    }

    // Anomalous resource usage on any current process
    for (const proc of curr.processes) {
      if (proc.cpu_percent > CPU_ANOMALOUS_PCT) {
        deltas.push({
          field: `process:${proc.name}:${proc.pid}:cpu`,
          classification: 'urgent',
          description: `Anomalous CPU: ${proc.name} (PID ${proc.pid}) at ${proc.cpu_percent}%`,
          curr_value: proc.cpu_percent,
        });
      }
      if (proc.mem_percent > MEM_ANOMALOUS_PCT) {
        deltas.push({
          field: `process:${proc.name}:${proc.pid}:mem`,
          classification: 'urgent',
          description: `Anomalous memory: ${proc.name} (PID ${proc.pid}) at ${proc.mem_percent}%`,
          curr_value: proc.mem_percent,
        });
      }
    }

    return deltas;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private isRunning(status: string): boolean {
    const s = status.toLowerCase();
    return s.startsWith('up') || s.includes('running');
  }
}

// ── deterministic narrative summarizer ───────────────────────────────────────

/**
 * Build a human-readable heartbeat narrative from accumulated notable/urgent
 * deltas without calling any external provider.
 * Safety gate: never includes raw command output, only classified descriptions.
 */
export function buildDeterministicNarrative(
  deltas: EnvironmentDelta[],
  pulseCount: number,
  capturedAt: string,
): string {
  const urgent = deltas.filter((d) => d.classification === 'urgent');
  const notable = deltas.filter((d) => d.classification === 'notable');

  const lines: string[] = [`Heartbeat narrative — ${pulseCount} pulse(s) ending ${capturedAt}`];

  if (urgent.length === 0 && notable.length === 0) {
    lines.push('All systems routine. No notable or urgent changes detected.');
    return lines.join('\n');
  }

  if (urgent.length > 0) {
    lines.push(`URGENT (${urgent.length}):`);
    for (const d of urgent) {
      lines.push(`  • ${d.description}`);
    }
  }

  if (notable.length > 0) {
    lines.push(`Notable (${notable.length}):`);
    for (const d of notable) {
      lines.push(`  • ${d.description}`);
    }
  }

  const routineCount = deltas.length - urgent.length - notable.length;
  if (routineCount > 0) {
    lines.push(`Routine: ${routineCount} change(s) — see audit log for details.`);
  }

  return lines.join('\n');
}
