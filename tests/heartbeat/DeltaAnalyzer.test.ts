// Co-authored by FORGE (Session: forge-20260326221916-3025550)
// tests/heartbeat/DeltaAnalyzer.test.ts — JAL-010 DeltaAnalyzer unit tests

import {
  DeltaAnalyzer,
  buildDeterministicNarrative,
  DISK_URGENT_PCT,
  DISK_NOTABLE_DELTA_PCT,
  MEMORY_URGENT_MB,
  CPU_ANOMALOUS_PCT,
  MEM_ANOMALOUS_PCT,
} from '../../src/apex/heartbeat/DeltaAnalyzer';
import { EnvironmentSnapshot, EnvironmentDelta } from '../../src/apex/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function baseSnapshot(overrides: Partial<EnvironmentSnapshot> = {}): EnvironmentSnapshot {
  return {
    captured_at: new Date().toISOString(),
    processes: [],
    containers: [],
    disk_mounts: [{ mount: '/', total_bytes: 100_000, used_bytes: 50_000, avail_bytes: 50_000, use_percent: 50 }],
    available_memory_mb: 1024,
    network_connections: [],
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DeltaAnalyzer', () => {
  const analyzer = new DeltaAnalyzer();

  // ── First pulse (no prev) ────────────────────────────────────────────────────

  describe('first pulse', () => {
    it('returns empty deltas when prev is null', () => {
      const snap = baseSnapshot();
      const delta = analyzer.analyze(null, snap);
      expect(delta.deltas).toHaveLength(0);
      expect(delta.has_urgent).toBe(false);
      expect(delta.has_notable).toBe(false);
    });

    it('sets timestamp from current snapshot', () => {
      const snap = baseSnapshot();
      const delta = analyzer.analyze(null, snap);
      expect(delta.timestamp).toBe(snap.captured_at);
    });
  });

  // ── Disk analysis ────────────────────────────────────────────────────────────

  describe('disk', () => {
    it('classifies stable disk as routine', () => {
      const prev = baseSnapshot({ disk_mounts: [{ mount: '/', total_bytes: 100, used_bytes: 50, avail_bytes: 50, use_percent: 50 }] });
      const curr = baseSnapshot({ disk_mounts: [{ mount: '/', total_bytes: 100, used_bytes: 51, avail_bytes: 49, use_percent: 51 }] });
      const delta = analyzer.analyze(prev, curr);
      const diskDelta = delta.deltas.find((d) => d.field === 'disk:/');
      expect(diskDelta?.classification).toBe('routine');
    });

    it(`classifies disk >= ${DISK_URGENT_PCT}% as urgent`, () => {
      const prev = baseSnapshot({ disk_mounts: [{ mount: '/', total_bytes: 100, used_bytes: 80, avail_bytes: 20, use_percent: 80 }] });
      const curr = baseSnapshot({ disk_mounts: [{ mount: '/', total_bytes: 100, used_bytes: 85, avail_bytes: 15, use_percent: DISK_URGENT_PCT }] });
      const delta = analyzer.analyze(prev, curr);
      const diskDelta = delta.deltas.find((d) => d.field === 'disk:/');
      expect(diskDelta?.classification).toBe('urgent');
      expect(delta.has_urgent).toBe(true);
    });

    it(`classifies disk growth >= ${DISK_NOTABLE_DELTA_PCT}% as notable`, () => {
      const prev = baseSnapshot({ disk_mounts: [{ mount: '/', total_bytes: 100, used_bytes: 50, avail_bytes: 50, use_percent: 50 }] });
      const curr = baseSnapshot({ disk_mounts: [{ mount: '/', total_bytes: 100, used_bytes: 55, avail_bytes: 45, use_percent: 55 }] });
      const delta = analyzer.analyze(prev, curr);
      const diskDelta = delta.deltas.find((d) => d.field === 'disk:/');
      expect(diskDelta?.classification).toBe('notable');
      expect(delta.has_notable).toBe(true);
    });

    it('classifies new mount as notable', () => {
      const prev = baseSnapshot({ disk_mounts: [] });
      const curr = baseSnapshot({ disk_mounts: [{ mount: '/mnt/data', total_bytes: 100, used_bytes: 10, avail_bytes: 90, use_percent: 10 }] });
      const delta = analyzer.analyze(prev, curr);
      const diskDelta = delta.deltas.find((d) => d.field === 'disk:/mnt/data');
      expect(diskDelta?.classification).toBe('notable');
    });
  });

  // ── Memory analysis ──────────────────────────────────────────────────────────

  describe('memory', () => {
    it('classifies healthy memory as routine', () => {
      const prev = baseSnapshot({ available_memory_mb: 1024 });
      const curr = baseSnapshot({ available_memory_mb: 1000 });
      const delta = analyzer.analyze(prev, curr);
      const memDelta = delta.deltas.find((d) => d.field === 'memory');
      expect(memDelta?.classification).toBe('routine');
    });

    it(`classifies available memory < ${MEMORY_URGENT_MB} MB as urgent`, () => {
      const prev = baseSnapshot({ available_memory_mb: 600 });
      const curr = baseSnapshot({ available_memory_mb: MEMORY_URGENT_MB - 1 });
      const delta = analyzer.analyze(prev, curr);
      const memDelta = delta.deltas.find((d) => d.field === 'memory');
      expect(memDelta?.classification).toBe('urgent');
      expect(delta.has_urgent).toBe(true);
    });

    it('classifies large memory drop as notable', () => {
      const prev = baseSnapshot({ available_memory_mb: 2048 });
      const curr = baseSnapshot({ available_memory_mb: 2048 - 257 }); // > 256 MB drop
      const delta = analyzer.analyze(prev, curr);
      const memDelta = delta.deltas.find((d) => d.field === 'memory');
      expect(memDelta?.classification).toBe('notable');
    });

    it('skips memory analysis when available_memory_mb is -1', () => {
      const prev = baseSnapshot({ available_memory_mb: -1 });
      const curr = baseSnapshot({ available_memory_mb: -1 });
      const delta = analyzer.analyze(prev, curr);
      const memDelta = delta.deltas.find((d) => d.field === 'memory');
      expect(memDelta).toBeUndefined();
    });
  });

  // ── Container analysis ───────────────────────────────────────────────────────

  describe('containers', () => {
    it('classifies container that stopped unexpectedly as urgent', () => {
      const prev = baseSnapshot({ containers: [{ id: 'abc', name: 'nginx', status: 'Up 2 hours' }] });
      const curr = baseSnapshot({ containers: [{ id: 'abc', name: 'nginx', status: 'Exited (137) 1 minute ago' }] });
      const delta = analyzer.analyze(prev, curr);
      const d = delta.deltas.find((x) => x.field === 'container:nginx');
      expect(d?.classification).toBe('urgent');
    });

    it('classifies clean exit as notable', () => {
      const prev = baseSnapshot({ containers: [{ id: 'abc', name: 'worker', status: 'Up 1 hour' }] });
      const curr = baseSnapshot({ containers: [{ id: 'abc', name: 'worker', status: 'Exited (0) 30 seconds ago' }] });
      const delta = analyzer.analyze(prev, curr);
      const d = delta.deltas.find((x) => x.field === 'container:worker');
      expect(d?.classification).toBe('notable');
    });

    it('classifies container restart (stopped → running) as notable', () => {
      const prev = baseSnapshot({ containers: [{ id: 'abc', name: 'redis', status: 'Exited (1) 5 min ago' }] });
      const curr = baseSnapshot({ containers: [{ id: 'abc', name: 'redis', status: 'Up 30 seconds' }] });
      const delta = analyzer.analyze(prev, curr);
      const d = delta.deltas.find((x) => x.field === 'container:redis');
      expect(d?.classification).toBe('notable');
    });

    it('classifies new container as notable', () => {
      const prev = baseSnapshot({ containers: [] });
      const curr = baseSnapshot({ containers: [{ id: 'xyz', name: 'newapp', status: 'Up 1 second' }] });
      const delta = analyzer.analyze(prev, curr);
      const d = delta.deltas.find((x) => x.field === 'container:newapp');
      expect(d?.classification).toBe('notable');
    });

    it('classifies removed container as notable', () => {
      const prev = baseSnapshot({ containers: [{ id: 'abc', name: 'gone', status: 'Up 10 hours' }] });
      const curr = baseSnapshot({ containers: [] });
      const delta = analyzer.analyze(prev, curr);
      const d = delta.deltas.find((x) => x.field === 'container:gone');
      expect(d?.classification).toBe('notable');
    });

    it('classifies running container with only status text change as routine', () => {
      const prev = baseSnapshot({ containers: [{ id: 'abc', name: 'nginx', status: 'Up 2 hours' }] });
      const curr = baseSnapshot({ containers: [{ id: 'abc', name: 'nginx', status: 'Up 2 hours 5 minutes' }] });
      const delta = analyzer.analyze(prev, curr);
      const d = delta.deltas.find((x) => x.field === 'container:nginx');
      expect(d?.classification).toBe('routine');
    });
  });

  // ── Process analysis ─────────────────────────────────────────────────────────

  describe('processes', () => {
    it('classifies new process as notable', () => {
      const prev = baseSnapshot({ processes: [{ pid: 1, name: 'init', cpu_percent: 0, mem_percent: 0, status: 'S' }] });
      const curr = baseSnapshot({
        processes: [
          { pid: 1, name: 'init', cpu_percent: 0, mem_percent: 0, status: 'S' },
          { pid: 999, name: 'newproc', cpu_percent: 5, mem_percent: 1, status: 'R' },
        ],
      });
      const delta = analyzer.analyze(prev, curr);
      const d = delta.deltas.find((x) => x.field.includes('process:newproc'));
      expect(d?.classification).toBe('notable');
    });

    it(`classifies process CPU > ${CPU_ANOMALOUS_PCT}% as urgent`, () => {
      const prev = baseSnapshot({ processes: [{ pid: 123, name: 'worker', cpu_percent: 10, mem_percent: 5, status: 'R' }] });
      const curr = baseSnapshot({ processes: [{ pid: 123, name: 'worker', cpu_percent: CPU_ANOMALOUS_PCT + 1, mem_percent: 5, status: 'R' }] });
      const delta = analyzer.analyze(prev, curr);
      const d = delta.deltas.find((x) => x.field.includes('cpu'));
      expect(d?.classification).toBe('urgent');
    });

    it(`classifies process MEM > ${MEM_ANOMALOUS_PCT}% as urgent`, () => {
      const prev = baseSnapshot({ processes: [{ pid: 123, name: 'leaky', cpu_percent: 1, mem_percent: 5, status: 'S' }] });
      const curr = baseSnapshot({ processes: [{ pid: 123, name: 'leaky', cpu_percent: 1, mem_percent: MEM_ANOMALOUS_PCT + 1, status: 'S' }] });
      const delta = analyzer.analyze(prev, curr);
      // Match process memory field specifically (not the 'memory' available-RAM field)
      const d = delta.deltas.find((x) => x.field.includes(':mem'));
      expect(d?.classification).toBe('urgent');
    });
  });

  // ── has_urgent / has_notable flags ───────────────────────────────────────────

  describe('flags', () => {
    it('has_urgent is false when all changes are routine or notable', () => {
      const prev = baseSnapshot({ disk_mounts: [{ mount: '/', total_bytes: 100, used_bytes: 50, avail_bytes: 50, use_percent: 50 }] });
      const curr = baseSnapshot({ disk_mounts: [{ mount: '/', total_bytes: 100, used_bytes: 55, avail_bytes: 45, use_percent: 55 }] });
      const delta = analyzer.analyze(prev, curr);
      expect(delta.has_notable).toBe(true);
      expect(delta.has_urgent).toBe(false);
    });

    it('has_urgent is true when any change is urgent', () => {
      const prev = baseSnapshot();
      const curr = baseSnapshot({ available_memory_mb: 100 });
      const delta = analyzer.analyze(prev, curr);
      expect(delta.has_urgent).toBe(true);
    });
  });
});

// ── buildDeterministicNarrative ───────────────────────────────────────────────

describe('buildDeterministicNarrative', () => {
  it('produces all-routine message when no notable/urgent deltas', () => {
    const narrative = buildDeterministicNarrative([], 12, new Date().toISOString());
    expect(narrative).toContain('routine');
    expect(narrative).toContain('No notable or urgent');
  });

  it('includes urgent items', () => {
    const deltas: EnvironmentDelta[] = [
      { field: 'disk:/', classification: 'urgent', description: 'Disk / at 90%' },
    ];
    const narrative = buildDeterministicNarrative(deltas, 5, new Date().toISOString());
    expect(narrative).toContain('URGENT');
    expect(narrative).toContain('Disk / at 90%');
  });

  it('includes notable items', () => {
    const deltas: EnvironmentDelta[] = [
      { field: 'container:nginx', classification: 'notable', description: 'nginx restarted' },
    ];
    const narrative = buildDeterministicNarrative(deltas, 3, new Date().toISOString());
    expect(narrative).toContain('Notable');
    expect(narrative).toContain('nginx restarted');
  });

  it('includes routine count', () => {
    const deltas: EnvironmentDelta[] = [
      { field: 'disk:/', classification: 'routine', description: 'stable' },
      { field: 'memory', classification: 'routine', description: 'healthy' },
      { field: 'container:app', classification: 'notable', description: 'restarted' },
    ];
    const narrative = buildDeterministicNarrative(deltas, 12, new Date().toISOString());
    expect(narrative).toContain('Routine: 2');
  });

  it('includes pulse count in header', () => {
    const narrative = buildDeterministicNarrative([], 24, '2026-03-26T00:00:00.000Z');
    expect(narrative).toContain('24 pulse');
  });

  it('never includes raw command output — descriptions only', () => {
    // Verify that no shell metacharacters / command patterns leak into narrative
    const deltas: EnvironmentDelta[] = [
      { field: 'test', classification: 'notable', description: 'Container abc123 restarted' },
    ];
    const narrative = buildDeterministicNarrative(deltas, 1, new Date().toISOString());
    // Should not contain $ { } ` (shell command characters)
    expect(narrative).not.toMatch(/\$\{/);
    expect(narrative).not.toMatch(/`/);
  });
});
