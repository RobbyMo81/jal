// Co-authored by FORGE (Session: forge-20260325062232-1899997)
// tests/heartbeat/HeartbeatScheduler.test.ts — JAL-006 test suite

import { parsePlaybook, parseYamlRaw, ParseError } from '../../src/apex/heartbeat/YamlPlaybookParser';
import { MemoryPlaybookHealthStore } from '../../src/apex/heartbeat/PlaybookHealthStore';
import { DiskPressureTracker, HealthChecks, IHeartbeatShell, ShellExecResult } from '../../src/apex/heartbeat/HealthChecks';
import { PlaybookRunner } from '../../src/apex/heartbeat/PlaybookRunner';
import { HeartbeatScheduler } from '../../src/apex/heartbeat/HeartbeatScheduler';
import { CapturingAuditLog, NoOpAuditLog } from '../../src/apex/policy/AuditLog';
import { PlaybookDefinition, HeartbeatCheckResult } from '../../src/apex/types';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a MockShell with configurable per-command responses. */
class MockShell implements IHeartbeatShell {
  private responses: Map<string, ShellExecResult> = new Map();
  private default_: ShellExecResult = { exit_code: 0, stdout: '', stderr: '' };
  readonly calls: Array<{ cmd: string; timeoutMs?: number }> = [];

  when(cmd: string, result: ShellExecResult): this {
    this.responses.set(cmd, result);
    return this;
  }

  whenContains(fragment: string, result: ShellExecResult): this {
    // Stored as a special prefix marker
    this.responses.set(`__contains:${fragment}`, result);
    return this;
  }

  setDefault(r: ShellExecResult): this {
    this.default_ = r;
    return this;
  }

  exec(cmd: string, timeoutMs?: number): ShellExecResult {
    this.calls.push({ cmd, timeoutMs });
    // Exact match
    if (this.responses.has(cmd)) return this.responses.get(cmd)!;
    // Contains match
    for (const [key, val] of this.responses) {
      if (key.startsWith('__contains:') && cmd.includes(key.slice(11))) return val;
    }
    return this.default_;
  }
}

function buildPlaybook(overrides: Partial<PlaybookDefinition> = {}): PlaybookDefinition {
  return {
    name: 'test-playbook',
    description: 'A test playbook',
    staging: false,
    triggers: [{ type: 'high_disk_pressure' }],
    steps: [{ name: 'step1', command: 'echo ok', timeout: 10 }],
    max_runtime: 60,
    rollback_commands: [],
    rollback_failure_policy: 'degrade',
    ...overrides,
  };
}

function makeCheck(
  check: string,
  healthy: boolean,
  metadata: Record<string, unknown> = {},
): HeartbeatCheckResult {
  return {
    check,
    healthy,
    exit_code: healthy ? 0 : 1,
    output: '',
    checked_at: new Date().toISOString(),
    metadata,
  };
}

// ── YamlPlaybookParser ────────────────────────────────────────────────────────

describe('YamlPlaybookParser — parseYamlRaw', () => {
  beforeEach(() => jest.clearAllMocks());

  it('parses scalar fields', () => {
    const raw = parseYamlRaw('name: disk-cleanup\ndescription: test\nstaging: false\nmax_runtime: 300');
    expect(raw['name']).toBe('disk-cleanup');
    expect(raw['description']).toBe('test');
    expect(raw['staging']).toBe(false);
    expect(raw['max_runtime']).toBe(300);
  });

  it('parses a sequence of plain strings', () => {
    const raw = parseYamlRaw('rollback_commands:\n  - docker restart app\n  - systemctl restart nginx');
    expect(raw['rollback_commands']).toEqual(['docker restart app', 'systemctl restart nginx']);
  });

  it('parses a sequence of objects', () => {
    const yaml = [
      'triggers:',
      '  - type: high_disk_pressure',
      '  - type: service_down',
      '    service: nginx',
    ].join('\n');
    const raw = parseYamlRaw(yaml);
    const triggers = raw['triggers'] as Array<Record<string, unknown>>;
    expect(triggers).toHaveLength(2);
    expect(triggers[0]).toMatchObject({ type: 'high_disk_pressure' });
    expect(triggers[1]).toMatchObject({ type: 'service_down', service: 'nginx' });
  });

  it('parses steps with multiple fields', () => {
    const yaml = [
      'steps:',
      '  - name: cleanup',
      '    command: find /tmp -mtime +7 -delete',
      '    timeout: 60',
    ].join('\n');
    const raw = parseYamlRaw(yaml);
    const steps = raw['steps'] as Array<Record<string, unknown>>;
    expect(steps[0]).toMatchObject({ name: 'cleanup', command: 'find /tmp -mtime +7 -delete', timeout: 60 });
  });

  it('ignores comment lines', () => {
    const raw = parseYamlRaw('# This is a comment\nname: my-playbook\n# Another comment');
    expect(raw['name']).toBe('my-playbook');
    expect(Object.keys(raw)).toEqual(['name']);
  });

  it('handles quoted string values', () => {
    const raw = parseYamlRaw('expression: "test -f /tmp/file.txt"');
    expect(raw['expression']).toBe('test -f /tmp/file.txt');
  });

  it('does not treat shell commands with colons as key-value', () => {
    const yaml = 'rollback_commands:\n  - docker restart my-app:latest\n  - echo done';
    const raw = parseYamlRaw(yaml);
    const cmds = raw['rollback_commands'] as string[];
    expect(cmds[0]).toBe('docker restart my-app:latest');
    expect(cmds[1]).toBe('echo done');
  });
});

describe('YamlPlaybookParser — parsePlaybook', () => {
  const validYaml = [
    'name: disk-cleanup',
    'description: Clean up disk when pressure is high',
    'staging: false',
    'max_runtime: 300',
    'triggers:',
    '  - type: high_disk_pressure',
    'steps:',
    '  - name: remove-tmp',
    '    command: find /tmp -mtime +7 -delete',
    '    timeout: 60',
    'rollback_commands:',
    '  - echo rollback',
    'rollback_failure_policy: degrade',
  ].join('\n');

  it('parses a valid playbook', () => {
    const pb = parsePlaybook(validYaml);
    expect(pb.name).toBe('disk-cleanup');
    expect(pb.staging).toBe(false);
    expect(pb.max_runtime).toBe(300);
    expect(pb.triggers).toHaveLength(1);
    expect(pb.steps).toHaveLength(1);
    expect(pb.rollback_commands).toEqual(['echo rollback']);
    expect(pb.rollback_failure_policy).toBe('degrade');
  });

  it('throws ParseError for missing required field', () => {
    const yaml = validYaml.replace('name: disk-cleanup\n', '');
    expect(() => parsePlaybook(yaml)).toThrow(ParseError);
    expect(() => parsePlaybook(yaml)).toThrow("Missing required field 'name'");
  });

  it('throws ParseError for invalid rollback_failure_policy', () => {
    const yaml = validYaml.replace('rollback_failure_policy: degrade', 'rollback_failure_policy: explode');
    expect(() => parsePlaybook(yaml)).toThrow(ParseError);
  });

  it('throws ParseError for invalid trigger type', () => {
    const yaml = validYaml.replace('type: high_disk_pressure', 'type: bad_trigger');
    expect(() => parsePlaybook(yaml)).toThrow(ParseError);
  });

  it('parses all valid trigger types', () => {
    const triggerTypes = ['high_disk_pressure', 'service_down', 'memory_pressure', 'failed_task', 'custom'];
    for (const tt of triggerTypes) {
      const yaml = validYaml.replace('type: high_disk_pressure', `type: ${tt}`);
      expect(() => parsePlaybook(yaml)).not.toThrow();
    }
  });

  it('parses staging=true', () => {
    const yaml = validYaml.replace('staging: false', 'staging: true');
    const pb = parsePlaybook(yaml);
    expect(pb.staging).toBe(true);
  });

  it('parses custom trigger with expression', () => {
    const yaml = validYaml.replace(
      'triggers:\n  - type: high_disk_pressure',
      'triggers:\n  - type: custom\n    expression: test -f /tmp/flag',
    );
    const pb = parsePlaybook(yaml);
    expect(pb.triggers[0]).toMatchObject({ type: 'custom', expression: 'test -f /tmp/flag' });
  });

  it('parses service_down trigger with service field', () => {
    const yaml = validYaml.replace(
      'triggers:\n  - type: high_disk_pressure',
      'triggers:\n  - type: service_down\n    service: nginx',
    );
    const pb = parsePlaybook(yaml);
    expect(pb.triggers[0]).toMatchObject({ type: 'service_down', service: 'nginx' });
  });
});

// ── DiskPressureTracker ───────────────────────────────────────────────────────

describe('DiskPressureTracker', () => {
  let tracker: DiskPressureTracker;

  beforeEach(() => {
    tracker = new DiskPressureTracker();
  });

  it('returns false on first high reading (not yet sustained)', () => {
    expect(tracker.update(90)).toBe(false);
    expect(tracker.firstHighTimestamp).not.toBeNull();
  });

  it('returns false if not sustained long enough', () => {
    tracker.setFirstHighAt(Date.now() - 4 * 60 * 1000); // 4 min ago
    expect(tracker.update(90)).toBe(false);
  });

  it('returns true when sustained ≥5 min', () => {
    tracker.setFirstHighAt(Date.now() - 6 * 60 * 1000); // 6 min ago
    expect(tracker.update(90)).toBe(true);
  });

  it('resets when pressure drops below threshold', () => {
    tracker.setFirstHighAt(Date.now() - 6 * 60 * 1000);
    tracker.update(50); // under threshold
    expect(tracker.firstHighTimestamp).toBeNull();
    expect(tracker.update(90)).toBe(false); // fresh start
  });

  it('stays false at exactly threshold-1 percent', () => {
    tracker.setFirstHighAt(Date.now() - 6 * 60 * 1000);
    expect(tracker.update(84)).toBe(false);
    expect(tracker.firstHighTimestamp).toBeNull();
  });
});

// ── HealthChecks ──────────────────────────────────────────────────────────────

describe('HealthChecks', () => {
  let shell: MockShell;
  let tracker: DiskPressureTracker;
  let hc: HealthChecks;

  beforeEach(() => {
    shell = new MockShell();
    tracker = new DiskPressureTracker();
    hc = new HealthChecks(shell, tracker);
  });

  describe('checkProcessHealth', () => {
    it('returns healthy when process count is non-zero', () => {
      shell.whenContains('wc -l', { exit_code: 0, stdout: '42', stderr: '' });
      const r = hc.checkProcessHealth();
      expect(r.check).toBe('process_health');
      expect(r.healthy).toBe(true);
      expect(r.metadata?.['process_count']).toBe(42);
    });

    it('returns unhealthy on command failure', () => {
      shell.whenContains('wc -l', { exit_code: 1, stdout: '', stderr: 'error' });
      const r = hc.checkProcessHealth();
      expect(r.healthy).toBe(false);
    });
  });

  describe('checkDiskPressure', () => {
    it('returns healthy when disk < 85%', () => {
      shell.whenContains("awk 'NR==2", { exit_code: 0, stdout: '70%\n', stderr: '' });
      const r = hc.checkDiskPressure();
      expect(r.check).toBe('disk_pressure');
      expect(r.healthy).toBe(true);
      expect(r.metadata?.['usage_percent']).toBe(70);
      expect(r.metadata?.['triggered']).toBe(false);
    });

    it('returns unhealthy and triggered=false on first high reading', () => {
      shell.whenContains("awk 'NR==2", { exit_code: 0, stdout: '90%\n', stderr: '' });
      const r = hc.checkDiskPressure();
      expect(r.healthy).toBe(false);
      expect(r.metadata?.['triggered']).toBe(false); // not yet sustained
    });

    it('returns triggered=true when sustained ≥5 min', () => {
      tracker.setFirstHighAt(Date.now() - 6 * 60 * 1000);
      shell.whenContains("awk 'NR==2", { exit_code: 0, stdout: '92%\n', stderr: '' });
      const r = hc.checkDiskPressure();
      expect(r.metadata?.['triggered']).toBe(true);
    });

    it('returns unhealthy on df command failure', () => {
      shell.whenContains("awk 'NR==2", { exit_code: 1, stdout: '', stderr: 'df: error' });
      const r = hc.checkDiskPressure();
      expect(r.healthy).toBe(false);
      expect(r.exit_code).toBe(1);
    });
  });

  describe('checkContainerStatus', () => {
    it('returns healthy when docker ps succeeds', () => {
      shell.whenContains('docker ps', { exit_code: 0, stdout: 'app\tUp 2 hours\nnginx\tUp 1 day', stderr: '' });
      const r = hc.checkContainerStatus();
      expect(r.check).toBe('container_status');
      expect(r.healthy).toBe(true);
      expect(r.metadata?.['container_count']).toBe(2);
    });

    it('returns unhealthy when docker daemon is down', () => {
      shell.whenContains('docker ps', { exit_code: 1, stdout: '', stderr: 'Cannot connect to Docker daemon' });
      const r = hc.checkContainerStatus();
      expect(r.healthy).toBe(false);
    });
  });

  describe('checkFailedJobs', () => {
    it('returns healthy when no failed jobs', () => {
      shell.setDefault({ exit_code: 0, stdout: '{"jobs":[{"status":"success"}]}', stderr: '' });
      const r = hc.checkFailedJobs('/fake/path/jobs.json');
      expect(r.check).toBe('failed_job');
      expect(r.healthy).toBe(true);
      expect(r.metadata?.['failed_count']).toBe(0);
    });

    it('returns unhealthy when failed job with no retry exists', () => {
      const jobs = JSON.stringify({ jobs: [{ status: 'failed', retry_in_flight: false }] });
      shell.setDefault({ exit_code: 0, stdout: jobs, stderr: '' });
      const r = hc.checkFailedJobs('/fake/path/jobs.json');
      expect(r.healthy).toBe(false);
      expect(r.metadata?.['triggered']).toBe(true);
      expect(r.metadata?.['failed_count']).toBe(1);
    });

    it('ignores failed jobs that have retry in flight', () => {
      const jobs = JSON.stringify({ jobs: [{ status: 'failed', retry_in_flight: true }] });
      shell.setDefault({ exit_code: 0, stdout: jobs, stderr: '' });
      const r = hc.checkFailedJobs('/fake/path/jobs.json');
      expect(r.healthy).toBe(true);
    });

    it('returns healthy when jobs file absent', () => {
      shell.setDefault({ exit_code: 1, stdout: '', stderr: 'No such file' });
      const r = hc.checkFailedJobs('/nonexistent/jobs.json');
      expect(r.healthy).toBe(true);
    });
  });
});

// ── MemoryPlaybookHealthStore ─────────────────────────────────────────────────

describe('MemoryPlaybookHealthStore', () => {
  it('starts with no degraded playbooks', () => {
    const store = new MemoryPlaybookHealthStore();
    expect(store.isDegraded('my-playbook')).toBe(false);
  });

  it('marks a playbook degraded', () => {
    const store = new MemoryPlaybookHealthStore();
    store.markDegraded('my-playbook', 'rollback failed');
    expect(store.isDegraded('my-playbook')).toBe(true);
    const entry = store.getAll().playbooks['my-playbook'];
    expect(entry.degraded_reason).toBe('rollback failed');
    expect(entry.degraded_at).toBeDefined();
  });

  it('records a run with exit code', () => {
    const store = new MemoryPlaybookHealthStore();
    store.recordRun('my-playbook', 0);
    const entry = store.getAll().playbooks['my-playbook'];
    expect(entry.last_exit_code).toBe(0);
    expect(entry.last_run).toBeDefined();
  });

  it('operator can clear degraded flag via setDegraded', () => {
    const store = new MemoryPlaybookHealthStore();
    store.markDegraded('my-playbook', 'reason');
    store.setDegraded('my-playbook', false);
    expect(store.isDegraded('my-playbook')).toBe(false);
  });

  it('increments version on each write', () => {
    const store = new MemoryPlaybookHealthStore();
    expect(store.getAll().version).toBe(0);
    store.markDegraded('a', 'x');
    expect(store.getAll().version).toBe(1);
    store.recordRun('b', 0);
    expect(store.getAll().version).toBe(2);
  });
});

// ── PlaybookRunner ────────────────────────────────────────────────────────────

describe('PlaybookRunner — evaluateTriggers', () => {
  let shell: MockShell;
  let audit: CapturingAuditLog;
  let store: MemoryPlaybookHealthStore;
  let runner: PlaybookRunner;

  beforeEach(() => {
    shell = new MockShell();
    audit = new CapturingAuditLog();
    store = new MemoryPlaybookHealthStore();
    runner = new PlaybookRunner(shell, audit, store);
  });

  it('includes playbook when high_disk_pressure trigger fires', () => {
    const pb = buildPlaybook({ triggers: [{ type: 'high_disk_pressure' }] });
    const checks = [makeCheck('disk_pressure', false, { triggered: true })];
    const { executable } = runner.evaluateTriggers([pb], checks);
    expect(executable).toHaveLength(1);
  });

  it('excludes playbook when trigger does not fire', () => {
    const pb = buildPlaybook({ triggers: [{ type: 'high_disk_pressure' }] });
    const checks = [makeCheck('disk_pressure', true, { triggered: false })];
    const { executable } = runner.evaluateTriggers([pb], checks);
    expect(executable).toHaveLength(0);
  });

  it('blocks staging=true playbooks from execution — queued instead', () => {
    const pb = buildPlaybook({ staging: true, triggers: [{ type: 'high_disk_pressure' }] });
    const checks = [makeCheck('disk_pressure', false, { triggered: true })];
    const { executable, staged } = runner.evaluateTriggers([pb], checks);
    expect(executable).toHaveLength(0);
    expect(staged).toHaveLength(1);
    expect(staged[0].name).toBe('test-playbook');
  });

  it('blocks degraded playbooks from execution', () => {
    store.markDegraded('test-playbook', 'prior failure');
    const pb = buildPlaybook({ triggers: [{ type: 'high_disk_pressure' }] });
    const checks = [makeCheck('disk_pressure', false, { triggered: true })];
    const { executable } = runner.evaluateTriggers([pb], checks);
    expect(executable).toHaveLength(0);
  });

  it('fires memory_pressure trigger when available_mb < 512', () => {
    const pb = buildPlaybook({ triggers: [{ type: 'memory_pressure' }] });
    const mc = makeCheck('process_health', false, { available_mb: 256, triggered: true });
    const { executable } = runner.evaluateTriggers([pb], [mc]);
    expect(executable).toHaveLength(1);
  });

  it('fires failed_task trigger when jobs exist with no retry', () => {
    const pb = buildPlaybook({ triggers: [{ type: 'failed_task' }] });
    const fc = makeCheck('failed_job', false, { failed_count: 2, triggered: true });
    const { executable } = runner.evaluateTriggers([pb], [fc]);
    expect(executable).toHaveLength(1);
  });

  it('fires service_down trigger via shell exec (non-zero exit)', () => {
    shell.whenContains('systemctl is-active', { exit_code: 1, stdout: '', stderr: '' });
    const pb = buildPlaybook({ triggers: [{ type: 'service_down', service: 'nginx' }] });
    const { executable } = runner.evaluateTriggers([pb], []);
    expect(executable).toHaveLength(1);
  });

  it('does not fire service_down trigger when service is active', () => {
    shell.whenContains('systemctl is-active', { exit_code: 0, stdout: 'active', stderr: '' });
    const pb = buildPlaybook({ triggers: [{ type: 'service_down', service: 'nginx' }] });
    const { executable } = runner.evaluateTriggers([pb], []);
    expect(executable).toHaveLength(0);
  });

  it('fires custom trigger when expression exits 0', () => {
    shell.whenContains('bash -c', { exit_code: 0, stdout: '', stderr: '' });
    const pb = buildPlaybook({ triggers: [{ type: 'custom', expression: 'test -f /tmp/flag' }] });
    const { executable } = runner.evaluateTriggers([pb], []);
    expect(executable).toHaveLength(1);
  });

  it('does not fire custom trigger when expression exits non-zero', () => {
    shell.whenContains('bash -c', { exit_code: 1, stdout: '', stderr: '' });
    const pb = buildPlaybook({ triggers: [{ type: 'custom', expression: 'test -f /tmp/flag' }] });
    const { executable } = runner.evaluateTriggers([pb], []);
    expect(executable).toHaveLength(0);
  });

  it('calls onStagingQueued callback for staging=true playbooks', () => {
    const queued: string[] = [];
    const r = new PlaybookRunner(shell, audit, store, { onStagingQueued: (n) => queued.push(n) });
    const pb = buildPlaybook({ staging: true, triggers: [{ type: 'high_disk_pressure' }] });
    const checks = [makeCheck('disk_pressure', false, { triggered: true })];
    r.evaluateTriggers([pb], checks);
    expect(queued).toContain('test-playbook');
  });
});

describe('PlaybookRunner — executePlaybook', () => {
  let shell: MockShell;
  let audit: CapturingAuditLog;
  let store: MemoryPlaybookHealthStore;
  let alerts: string[];
  let runner: PlaybookRunner;

  beforeEach(() => {
    shell = new MockShell();
    audit = new CapturingAuditLog();
    store = new MemoryPlaybookHealthStore();
    alerts = [];
    runner = new PlaybookRunner(shell, audit, store, {
      onDegradeAlert: (n) => alerts.push(n),
    });
  });

  it('executes all steps and records the run', async () => {
    shell.setDefault({ exit_code: 0, stdout: 'done', stderr: '' });
    const pb = buildPlaybook({
      steps: [
        { name: 's1', command: 'echo s1', timeout: 5 },
        { name: 's2', command: 'echo s2', timeout: 5 },
      ],
    });
    const result = await runner.executePlaybook(pb);
    expect(result.steps_run).toBe(2);
    expect(result.steps_failed).toBe(0);
    expect(store.getAll().playbooks['test-playbook'].last_exit_code).toBe(0);
  });

  it('audit-logs start and finish events', async () => {
    shell.setDefault({ exit_code: 0, stdout: '', stderr: '' });
    await runner.executePlaybook(buildPlaybook());
    const actions = audit.entries.map((e) => e['action']);
    expect(actions).toContain('playbook.start');
    expect(actions).toContain('playbook.step');
    expect(actions).toContain('playbook.finish');
  });

  it('stops steps on first failure and attempts rollback', async () => {
    shell.when('echo step1', { exit_code: 1, stdout: '', stderr: 'fail' });
    shell.when('echo rollback', { exit_code: 0, stdout: '', stderr: '' });
    const pb = buildPlaybook({
      steps: [{ name: 's1', command: 'echo step1' }],
      rollback_commands: ['echo rollback'],
    });
    const result = await runner.executePlaybook(pb);
    expect(result.steps_failed).toBe(1);
    expect(result.rollback_attempted).toBe(true);
    expect(result.rollback_success).toBe(true);
  });

  it('marks playbook degraded when rollback fails and policy=degrade', async () => {
    shell.setDefault({ exit_code: 1, stdout: '', stderr: 'fail' });
    const pb = buildPlaybook({
      steps: [{ name: 's1', command: 'echo step' }],
      rollback_commands: ['echo rb'],
      rollback_failure_policy: 'degrade',
    });
    const result = await runner.executePlaybook(pb);
    expect(result.degraded).toBe(true);
    expect(store.isDegraded('test-playbook')).toBe(true);
    expect(alerts).toContain('test-playbook');
  });

  it('alerts operator via onDegradeAlert callback on degraded state', async () => {
    shell.setDefault({ exit_code: 1, stdout: '', stderr: '' });
    const pb = buildPlaybook({
      steps: [{ name: 's1', command: 'fail' }],
      rollback_commands: ['also-fail'],
      rollback_failure_policy: 'degrade',
    });
    await runner.executePlaybook(pb);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toBe('test-playbook');
  });

  it('does not degrade when rollback_failure_policy=ignore', async () => {
    shell.setDefault({ exit_code: 1, stdout: '', stderr: '' });
    const pb = buildPlaybook({
      steps: [{ name: 's1', command: 'fail' }],
      rollback_commands: ['also-fail'],
      rollback_failure_policy: 'ignore',
    });
    const result = await runner.executePlaybook(pb);
    expect(result.degraded).toBe(false);
    expect(store.isDegraded('test-playbook')).toBe(false);
  });

  it('treats empty rollback_commands as rollback success', async () => {
    shell.setDefault({ exit_code: 1, stdout: '', stderr: '' });
    const pb = buildPlaybook({
      steps: [{ name: 's1', command: 'fail' }],
      rollback_commands: [],
      rollback_failure_policy: 'degrade',
    });
    const result = await runner.executePlaybook(pb);
    expect(result.rollback_attempted).toBe(true);
    expect(result.rollback_success).toBe(true);
    expect(result.degraded).toBe(false);
  });

  it('audit-logs rollback steps', async () => {
    shell.setDefault({ exit_code: 1, stdout: '', stderr: '' });
    const pb = buildPlaybook({
      steps: [{ name: 's1', command: 'fail' }],
      rollback_commands: ['echo rb'],
    });
    await runner.executePlaybook(pb);
    const actions = audit.entries.map((e) => e['action']);
    expect(actions).toContain('playbook.rollback_step');
  });

  it('audit-logs degraded state with error level', async () => {
    shell.setDefault({ exit_code: 1, stdout: '', stderr: '' });
    const pb = buildPlaybook({
      steps: [{ name: 's1', command: 'fail' }],
      rollback_commands: ['also-fail'],
      rollback_failure_policy: 'degrade',
    });
    await runner.executePlaybook(pb);
    const degradeEntry = audit.entries.find((e) => e['action'] === 'playbook.degraded');
    expect(degradeEntry).toBeDefined();
    expect(degradeEntry?.level).toBe('error');
  });
});

// ── HeartbeatScheduler ────────────────────────────────────────────────────────

describe('HeartbeatScheduler — configuration', () => {
  it('uses default interval of 300s', () => {
    delete process.env['APEX_HEARTBEAT_INTERVAL_SEC'];
    const s = new HeartbeatScheduler({ auditLog: new NoOpAuditLog() });
    expect(s.intervalSeconds).toBe(300);
  });

  it('reads interval from APEX_HEARTBEAT_INTERVAL_SEC env var', () => {
    process.env['APEX_HEARTBEAT_INTERVAL_SEC'] = '600';
    const s = new HeartbeatScheduler({ auditLog: new NoOpAuditLog() });
    expect(s.intervalSeconds).toBe(600);
    delete process.env['APEX_HEARTBEAT_INTERVAL_SEC'];
  });

  it('clamps interval to minimum of 60s', () => {
    const s = new HeartbeatScheduler({ intervalSec: 10, auditLog: new NoOpAuditLog() });
    expect(s.intervalSeconds).toBe(60);
  });

  it('clamps interval to maximum of 1800s', () => {
    const s = new HeartbeatScheduler({ intervalSec: 9999, auditLog: new NoOpAuditLog() });
    expect(s.intervalSeconds).toBe(1800);
  });

  it('accepts valid interval within range', () => {
    const s = new HeartbeatScheduler({ intervalSec: 120, auditLog: new NoOpAuditLog() });
    expect(s.intervalSeconds).toBe(120);
  });
});

describe('HeartbeatScheduler — lifecycle', () => {
  let shell: MockShell;
  let audit: CapturingAuditLog;
  let scheduler: HeartbeatScheduler;

  beforeEach(() => {
    shell = new MockShell().setDefault({ exit_code: 0, stdout: '10', stderr: '' });
    audit = new CapturingAuditLog();
    scheduler = new HeartbeatScheduler({
      shell,
      auditLog: audit,
      intervalSec: 60,
      playbookOptions: { playbooksDir: '/nonexistent/path' },
    });
  });

  afterEach(() => scheduler.stop());

  it('starts and reports isRunning=true', () => {
    scheduler.start();
    expect(scheduler.isRunning).toBe(true);
  });

  it('stops and reports isRunning=false', () => {
    scheduler.start();
    scheduler.stop();
    expect(scheduler.isRunning).toBe(false);
  });

  it('calling start twice is a no-op', () => {
    scheduler.start();
    scheduler.start();
    expect(scheduler.isRunning).toBe(true);
    scheduler.stop();
  });

  it('audit-logs heartbeat.start on start()', () => {
    scheduler.start();
    const startEntry = audit.entries.find((e) => e['action'] === 'heartbeat.start');
    expect(startEntry).toBeDefined();
    expect(startEntry?.level).toBe('info');
  });

  it('audit-logs heartbeat.stop on stop()', () => {
    scheduler.start();
    scheduler.stop();
    const stopEntry = audit.entries.find((e) => e['action'] === 'heartbeat.stop');
    expect(stopEntry).toBeDefined();
  });
});

describe('HeartbeatScheduler — runCycle', () => {
  let shell: MockShell;
  let audit: CapturingAuditLog;
  let store: MemoryPlaybookHealthStore;
  let scheduler: HeartbeatScheduler;

  const tmpPlaybooksDir = path.join(os.tmpdir(), `apex-test-playbooks-${process.pid}`);

  beforeAll(() => fs.mkdirSync(tmpPlaybooksDir, { recursive: true }));
  afterAll(() => fs.rmSync(tmpPlaybooksDir, { recursive: true, force: true }));
  afterEach(() => {
    // Clean up any playbook files written during a test
    for (const f of fs.readdirSync(tmpPlaybooksDir)) {
      fs.unlinkSync(path.join(tmpPlaybooksDir, f));
    }
  });

  beforeEach(() => {
    shell = new MockShell().setDefault({ exit_code: 0, stdout: '10', stderr: '' });
    audit = new CapturingAuditLog();
    store = new MemoryPlaybookHealthStore();
    scheduler = new HeartbeatScheduler({
      shell,
      auditLog: audit,
      healthStore: store,
      intervalSec: 60,
      playbookOptions: { playbooksDir: tmpPlaybooksDir },
    });
  });

  it('runs all four health checks per cycle', async () => {
    const result = await scheduler.runCycle();
    expect(result.checks).toHaveLength(4);
    const checkNames = result.checks.map((c) => c.check);
    expect(checkNames).toContain('process_health');
    expect(checkNames).toContain('disk_pressure');
    expect(checkNames).toContain('container_status');
    expect(checkNames).toContain('failed_job');
  });

  it('audit-logs cycle_start and cycle_end', async () => {
    await scheduler.runCycle();
    const actions = audit.entries.map((e) => e['action']);
    expect(actions).toContain('heartbeat.cycle_start');
    expect(actions).toContain('heartbeat.cycle_end');
  });

  it('audit-logs each health check result', async () => {
    await scheduler.runCycle();
    const checkEntries = audit.entries.filter((e) => e['action'] === 'heartbeat.check');
    expect(checkEntries.length).toBeGreaterThanOrEqual(4);
  });

  it('returns cycle_at timestamp in result', async () => {
    const before = Date.now();
    const result = await scheduler.runCycle();
    const after = Date.now();
    const cycleAt = new Date(result.cycle_at).getTime();
    expect(cycleAt).toBeGreaterThanOrEqual(before - 10);
    expect(cycleAt).toBeLessThanOrEqual(after + 10);
  });

  it('executes a staging=false playbook when trigger fires', async () => {
    const diskTracker = new DiskPressureTracker();
    diskTracker.setFirstHighAt(Date.now() - 6 * 60 * 1000);
    // Override disk shell
    shell.whenContains("awk 'NR==2", { exit_code: 0, stdout: '92%', stderr: '' });
    const sc = new HeartbeatScheduler({
      shell,
      auditLog: audit,
      healthStore: store,
      diskTracker,
      intervalSec: 60,
      playbookOptions: { playbooksDir: tmpPlaybooksDir },
    });
    // Write a playbook
    const yaml = [
      'name: disk-cleanup',
      'description: clean disk',
      'staging: false',
      'max_runtime: 60',
      'triggers:',
      '  - type: high_disk_pressure',
      'steps:',
      '  - name: clean',
      '    command: echo cleaned',
      '    timeout: 10',
      'rollback_commands: []',
      'rollback_failure_policy: degrade',
    ].join('\n');
    // Note: YAML parser needs rollback_commands as a list, not []
    const yaml2 = yaml.replace('rollback_commands: []', 'rollback_commands:\n  - echo no-op');
    fs.writeFileSync(path.join(tmpPlaybooksDir, 'disk-cleanup.yaml'), yaml2);
    const result = await sc.runCycle();
    expect(result.playbooks_triggered).toContain('disk-cleanup');
  });

  it('queues staging=true playbooks without executing them', async () => {
    const diskTracker = new DiskPressureTracker();
    diskTracker.setFirstHighAt(Date.now() - 6 * 60 * 1000);
    shell.whenContains("awk 'NR==2", { exit_code: 0, stdout: '92%', stderr: '' });
    const sc = new HeartbeatScheduler({
      shell,
      auditLog: audit,
      healthStore: store,
      diskTracker,
      intervalSec: 60,
      playbookOptions: { playbooksDir: tmpPlaybooksDir },
    });
    const yaml = [
      'name: staged-playbook',
      'description: needs review',
      'staging: true',
      'max_runtime: 60',
      'triggers:',
      '  - type: high_disk_pressure',
      'steps:',
      '  - name: s1',
      '    command: echo hi',
      '    timeout: 5',
      'rollback_commands:',
      '  - echo rb',
      'rollback_failure_policy: ignore',
    ].join('\n');
    fs.writeFileSync(path.join(tmpPlaybooksDir, 'staged.yaml'), yaml);
    const result = await sc.runCycle();
    expect(result.playbooks_staged).toContain('staged-playbook');
    expect(result.playbooks_triggered).not.toContain('staged-playbook');
  });

  it('continues cycle even when a playbook step fails', async () => {
    shell.whenContains("awk 'NR==2", { exit_code: 0, stdout: '92%', stderr: '' });
    const diskTracker = new DiskPressureTracker();
    diskTracker.setFirstHighAt(Date.now() - 6 * 60 * 1000);
    // All commands fail
    shell.setDefault({ exit_code: 1, stdout: '', stderr: 'fail' });
    shell.whenContains("awk 'NR==2", { exit_code: 0, stdout: '92%', stderr: '' });
    const sc = new HeartbeatScheduler({
      shell,
      auditLog: audit,
      healthStore: store,
      diskTracker,
      intervalSec: 60,
      playbookOptions: { playbooksDir: tmpPlaybooksDir },
    });
    const yaml = [
      'name: failing-playbook',
      'description: fails',
      'staging: false',
      'max_runtime: 60',
      'triggers:',
      '  - type: high_disk_pressure',
      'steps:',
      '  - name: fail-step',
      '    command: this-will-fail',
      '    timeout: 5',
      'rollback_commands:',
      '  - echo rb',
      'rollback_failure_policy: ignore',
    ].join('\n');
    fs.writeFileSync(path.join(tmpPlaybooksDir, 'failing.yaml'), yaml);
    // Should not throw
    const result = await sc.runCycle();
    expect(result).toBeDefined();
    // Cycle completed (cycle_end was logged)
    const actions = audit.entries.map((e) => e['action']);
    expect(actions).toContain('heartbeat.cycle_end');
  });

  it('skips degraded playbooks', async () => {
    store.markDegraded('disk-cleanup', 'prior failure');
    shell.whenContains("awk 'NR==2", { exit_code: 0, stdout: '92%', stderr: '' });
    const diskTracker = new DiskPressureTracker();
    diskTracker.setFirstHighAt(Date.now() - 6 * 60 * 1000);
    const sc = new HeartbeatScheduler({
      shell,
      auditLog: audit,
      healthStore: store,
      diskTracker,
      intervalSec: 60,
      playbookOptions: { playbooksDir: tmpPlaybooksDir },
    });
    const yaml = [
      'name: disk-cleanup',
      'description: clean',
      'staging: false',
      'max_runtime: 60',
      'triggers:',
      '  - type: high_disk_pressure',
      'steps:',
      '  - name: s1',
      '    command: echo ok',
      '    timeout: 5',
      'rollback_commands:',
      '  - echo rb',
      'rollback_failure_policy: degrade',
    ].join('\n');
    fs.writeFileSync(path.join(tmpPlaybooksDir, 'disk-cleanup.yaml'), yaml);
    const result = await sc.runCycle();
    expect(result.playbooks_triggered).not.toContain('disk-cleanup');
  });
});
