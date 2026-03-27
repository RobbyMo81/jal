// Co-authored by FORGE (Session: forge-20260326221916-3025550)
// tests/heartbeat/EnvironmentSnapshot.test.ts — JAL-010 SnapshotCollector unit tests

import { SnapshotCollector } from '../../src/apex/heartbeat/EnvironmentSnapshot';
import { IHeartbeatShell, ShellExecResult } from '../../src/apex/heartbeat/HealthChecks';

// ── StubShell ─────────────────────────────────────────────────────────────────

class StubShell implements IHeartbeatShell {
  private responses: Map<string, ShellExecResult> = new Map();
  readonly calls: string[] = [];

  when(fragment: string, result: ShellExecResult): this {
    this.responses.set(fragment, result);
    return this;
  }

  exec(cmd: string): ShellExecResult {
    this.calls.push(cmd);
    for (const [key, val] of this.responses) {
      if (cmd.includes(key)) return val;
    }
    return { exit_code: 0, stdout: '', stderr: '' };
  }
}

function ok(stdout: string): ShellExecResult {
  return { exit_code: 0, stdout, stderr: '' };
}

function fail(stderr = 'error'): ShellExecResult {
  return { exit_code: 1, stdout: '', stderr };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('SnapshotCollector', () => {
  // ── processes ───────────────────────────────────────────────────────────────

  describe('collectProcesses', () => {
    it('parses ps aux output into ProcessInfo records', () => {
      const shell = new StubShell().when('ps aux', ok(
        'root         1  0.0  0.1 169448 11212 ?        Ss   Mar24   0:01 /sbin/init\n' +
        'spoq      1234  2.5  1.0 123456 81920 pts/0    S    10:00   0:05 node dist/main.js\n'
      ));
      const col = new SnapshotCollector(shell);
      const procs = col.collectProcesses();
      expect(procs).toHaveLength(2);
      expect(procs[0]!.pid).toBe(1);
      expect(procs[0]!.cpu_percent).toBe(0.0);
      expect(procs[1]!.pid).toBe(1234);
      expect(procs[1]!.cpu_percent).toBe(2.5);
      expect(procs[1]!.mem_percent).toBe(1.0);
    });

    it('returns empty array on shell failure', () => {
      const shell = new StubShell().when('ps aux', fail());
      const col = new SnapshotCollector(shell);
      expect(col.collectProcesses()).toEqual([]);
    });

    it('returns empty array on empty output', () => {
      const shell = new StubShell().when('ps aux', ok(''));
      const col = new SnapshotCollector(shell);
      expect(col.collectProcesses()).toEqual([]);
    });

    it('skips malformed lines', () => {
      const shell = new StubShell().when('ps aux', ok('bad line\n'));
      const col = new SnapshotCollector(shell);
      expect(col.collectProcesses()).toEqual([]);
    });

    it('strips path prefix from command name', () => {
      const shell = new StubShell().when('ps aux', ok(
        'root 42 1.0 0.5 0 0 ? S 00:00 0:00 /usr/bin/python3 script.py\n'
      ));
      const col = new SnapshotCollector(shell);
      const procs = col.collectProcesses();
      expect(procs[0]!.name).toBe('python3');
    });
  });

  // ── containers ──────────────────────────────────────────────────────────────

  describe('collectContainers', () => {
    it('parses docker ps -a output', () => {
      const shell = new StubShell().when('docker ps', ok(
        'abc123\tnginx\tUp 2 hours\n' +
        'def456\tpostgres\tExited (0) 5 minutes ago\n'
      ));
      const col = new SnapshotCollector(shell);
      const containers = col.collectContainers();
      expect(containers).toHaveLength(2);
      expect(containers[0]!.id).toBe('abc123');
      expect(containers[0]!.name).toBe('nginx');
      expect(containers[0]!.status).toBe('Up 2 hours');
      expect(containers[1]!.status).toBe('Exited (0) 5 minutes ago');
    });

    it('returns empty array when docker fails', () => {
      const shell = new StubShell().when('docker ps', fail());
      const col = new SnapshotCollector(shell);
      expect(col.collectContainers()).toEqual([]);
    });

    it('returns empty array when no containers', () => {
      const shell = new StubShell().when('docker ps', ok(''));
      const col = new SnapshotCollector(shell);
      expect(col.collectContainers()).toEqual([]);
    });
  });

  // ── disk mounts ─────────────────────────────────────────────────────────────

  describe('collectDiskMounts', () => {
    const DF_OUTPUT = [
      'Filesystem     1K-blocks     Used Available Use% Mounted on',
      '/dev/sda1      104857600 52428800  49283200  52% /',
      'tmpfs              2048000        0   2048000   0% /dev/shm',
    ].join('\n');

    it('parses df -k output into DiskMount records', () => {
      const shell = new StubShell().when('df -k', ok(DF_OUTPUT));
      const col = new SnapshotCollector(shell);
      const mounts = col.collectDiskMounts();
      expect(mounts).toHaveLength(2);
      expect(mounts[0]!.mount).toBe('/');
      expect(mounts[0]!.use_percent).toBe(52);
      expect(mounts[0]!.total_bytes).toBe(104857600 * 1024);
      expect(mounts[1]!.mount).toBe('/dev/shm');
      expect(mounts[1]!.use_percent).toBe(0);
    });

    it('returns empty array on df failure', () => {
      const shell = new StubShell().when('df -k', fail());
      const col = new SnapshotCollector(shell);
      expect(col.collectDiskMounts()).toEqual([]);
    });
  });

  // ── memory ──────────────────────────────────────────────────────────────────

  describe('collectAvailableMemoryMb', () => {
    it('converts kB to MB correctly', () => {
      const shell = new StubShell().when('/proc/meminfo', ok('1048576\n'));
      const col = new SnapshotCollector(shell);
      expect(col.collectAvailableMemoryMb()).toBe(1024);
    });

    it('returns -1 on failure', () => {
      const shell = new StubShell().when('/proc/meminfo', fail());
      const col = new SnapshotCollector(shell);
      expect(col.collectAvailableMemoryMb()).toBe(-1);
    });

    it('returns -1 on non-numeric output', () => {
      const shell = new StubShell().when('/proc/meminfo', ok('not-a-number'));
      const col = new SnapshotCollector(shell);
      expect(col.collectAvailableMemoryMb()).toBe(-1);
    });
  });

  // ── network connections ──────────────────────────────────────────────────────

  describe('collectNetworkConnections', () => {
    const SS_OUTPUT = [
      'State  Recv-Q Send-Q Local Address:Port Peer Address:Port',
      'ESTAB  0      0      127.0.0.1:3000    127.0.0.1:52000',
      'LISTEN 0      128    0.0.0.0:22        0.0.0.0:*',
    ].join('\n');

    it('parses ss -tn output into NetworkConnection records', () => {
      const shell = new StubShell().when('ss -tn', ok(SS_OUTPUT));
      const col = new SnapshotCollector(shell);
      const conns = col.collectNetworkConnections();
      expect(conns.length).toBeGreaterThanOrEqual(2);
      expect(conns[0]!.state).toBe('ESTAB');
      expect(conns[0]!.local_addr).toBe('127.0.0.1:3000');
    });

    it('returns empty array on failure', () => {
      const shell = new StubShell().when('ss -tn', fail()).when('netstat -tn', fail());
      const col = new SnapshotCollector(shell);
      expect(col.collectNetworkConnections()).toEqual([]);
    });
  });

  // ── collect (full snapshot) ──────────────────────────────────────────────────

  describe('collect', () => {
    it('returns a complete EnvironmentSnapshot with captured_at', () => {
      const shell = new StubShell();
      const col = new SnapshotCollector(shell);
      const snap = col.collect();
      expect(snap.captured_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(Array.isArray(snap.processes)).toBe(true);
      expect(Array.isArray(snap.containers)).toBe(true);
      expect(Array.isArray(snap.disk_mounts)).toBe(true);
      expect(typeof snap.available_memory_mb).toBe('number');
      expect(Array.isArray(snap.network_connections)).toBe(true);
    });
  });
});
