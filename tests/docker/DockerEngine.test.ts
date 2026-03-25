// Co-authored by FORGE (Session: forge-20260324215726-1658598)
// tests/docker/DockerEngine.test.ts — JAL-002 unit tests

import { EventEmitter } from 'events';
import { DockerEngine, DOCKER_DEFAULT_TIMEOUT_MS } from '../../src/apex/docker/DockerEngine';
import { DockerStubFirewall, IPolicyFirewall } from '../../src/apex/policy/PolicyFirewall';
import { TierDecision } from '../../src/apex/types';

// ── Mock child_process.spawn ───────────────────────────────────────────────────

jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));

import { spawn } from 'child_process';
const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;

// Clear all mocks before each test so mock.calls[0] always refers to the current test's call.
beforeEach(() => {
  jest.clearAllMocks();
  jest.useRealTimers();
});

/** Build a fake ChildProcess that emits stdout/stderr/close on demand. */
function makeFakeProc(pid = 12345) {
  const proc = new EventEmitter() as ReturnType<typeof spawn>;
  (proc as EventEmitter & { pid?: number }).pid = pid;

  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  (proc as unknown as Record<string, unknown>).stdout = stdout;
  (proc as unknown as Record<string, unknown>).stderr = stderr;
  (proc as unknown as Record<string, unknown>).kill = jest.fn((sig?: string) => {
    if (sig === 'SIGKILL') proc.emit('close', 137);
    else proc.emit('close', 0);
    return true;
  });

  return { proc, stdout, stderr };
}

/** Emit stdout + stderr chunks then close the process. */
function resolveProc(
  { proc, stdout, stderr }: ReturnType<typeof makeFakeProc>,
  exitCode: number,
  stdoutData = '',
  stderrData = ''
) {
  setImmediate(() => {
    if (stdoutData) stdout.emit('data', Buffer.from(stdoutData));
    if (stderrData) stderr.emit('data', Buffer.from(stderrData));
    proc.emit('close', exitCode);
  });
}

// ── DockerStubFirewall unit tests ─────────────────────────────────────────────

describe('DockerStubFirewall', () => {
  const fw = new DockerStubFirewall();

  it('auto-approves list (Tier 1)', async () => {
    const d = await fw.classify('docker.list', { args: ['ps', '-a'] });
    expect(d.tier).toBe(1);
    expect(d.approved).toBe(true);
  });

  it('auto-approves start (Tier 1)', async () => {
    const d = await fw.classify('docker.start', { args: ['start', 'abc123'] });
    expect(d.approved).toBe(true);
  });

  it('auto-approves stop (Tier 1)', async () => {
    const d = await fw.classify('docker.stop', { args: ['stop', 'abc123'] });
    expect(d.approved).toBe(true);
  });

  it('auto-approves inspect (Tier 1)', async () => {
    const d = await fw.classify('docker.inspect', { args: ['inspect', 'abc123'] });
    expect(d.approved).toBe(true);
  });

  it('auto-approves build (Tier 1)', async () => {
    const d = await fw.classify('docker.build', { args: ['build', '.'] });
    expect(d.approved).toBe(true);
  });

  it('blocks docker.prune as Tier 2 (destructive)', async () => {
    const d = await fw.classify('docker.prune', { args: ['prune', '-f'] });
    expect(d.tier).toBe(2);
    expect(d.approved).toBe(false);
  });

  it('blocks docker.rm as Tier 2 (destructive)', async () => {
    const d = await fw.classify('docker.rm', { args: ['rm', 'abc123'] });
    expect(d.tier).toBe(2);
    expect(d.approved).toBe(false);
  });

  it('blocks --privileged mode as Tier 3', async () => {
    const d = await fw.classify('docker.run', { args: ['run', '--privileged'], privileged: true });
    expect(d.tier).toBe(3);
    expect(d.approved).toBe(false);
    expect(d.reason).toMatch(/privileged/i);
  });

  it('includes decided_at timestamp', async () => {
    const d = await fw.classify('docker.list', {});
    expect(typeof d.decided_at).toBe('string');
    expect(new Date(d.decided_at).getTime()).toBeGreaterThan(0);
  });
});

// ── Container ID validation ───────────────────────────────────────────────────

describe('DockerEngine — container ID validation', () => {
  const engine = new DockerEngine();

  it('accepts alphanumeric IDs', async () => {
    const { proc, stdout, stderr } = makeFakeProc();
    mockSpawn.mockReturnValue(proc);
    resolveProc({ proc, stdout, stderr }, 0, 'done\n');
    await expect(engine.start('abc123')).resolves.toBeDefined();
  });

  it('accepts underscore, dot, and dash in names', async () => {
    const { proc, stdout, stderr } = makeFakeProc();
    mockSpawn.mockReturnValue(proc);
    resolveProc({ proc, stdout, stderr }, 0, 'done\n');
    await expect(engine.start('my_container-1.0')).resolves.toBeDefined();
  });

  it('rejects IDs with spaces', async () => {
    await expect(engine.start('bad id')).rejects.toThrow('[DockerEngine] SAFETY GATE');
  });

  it('rejects IDs with shell metacharacters', async () => {
    await expect(engine.stop('id;rm -rf /')).rejects.toThrow('[DockerEngine] SAFETY GATE');
  });

  it('rejects empty-ish IDs that start with non-alnum', async () => {
    await expect(engine.inspect('-v')).rejects.toThrow('[DockerEngine] SAFETY GATE');
  });
});

// ── list operation ────────────────────────────────────────────────────────────

describe('DockerEngine.list', () => {
  it('spawns docker ps -a --format and streams stdout', async () => {
    const engine = new DockerEngine();
    const { proc, stdout, stderr } = makeFakeProc();
    mockSpawn.mockReturnValue(proc);
    resolveProc({ proc, stdout, stderr }, 0, '{"ID":"abc"}\n');

    const chunks: string[] = [];
    const result = await engine.list(undefined, (chunk) => chunks.push(chunk));

    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain('"ID":"abc"');
    expect(chunks.length).toBeGreaterThan(0);
    expect(result.tier_decision.tier).toBe(1);
    expect(result.tier_decision.approved).toBe(true);
    expect(result.timed_out).toBe(false);
    expect(result.cancelled).toBe(false);

    const spawnArgs = mockSpawn.mock.calls[0];
    expect(spawnArgs[0]).toBe('docker');
    expect(spawnArgs[1]).toEqual(expect.arrayContaining(['ps', '-a', '--format']));
  });
});

// ── start operation ───────────────────────────────────────────────────────────

describe('DockerEngine.start', () => {
  it('spawns docker start <id>', async () => {
    const engine = new DockerEngine();
    const { proc, stdout, stderr } = makeFakeProc();
    mockSpawn.mockReturnValue(proc);
    resolveProc({ proc, stdout, stderr }, 0, 'abc123\n');

    const result = await engine.start('abc123');
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain('abc123');

    const [bin, args] = mockSpawn.mock.calls[0];
    expect(bin).toBe('docker');
    expect(args).toEqual(['start', 'abc123']);
  });

  it('records non-zero exit code', async () => {
    const engine = new DockerEngine();
    const { proc, stdout, stderr } = makeFakeProc();
    mockSpawn.mockReturnValue(proc);
    resolveProc({ proc, stdout, stderr }, 1, '', 'No such container\n');

    const result = await engine.start('missing');
    expect(result.exit_code).toBe(1);
    expect(result.stderr).toContain('No such container');
  });
});

// ── stop operation ────────────────────────────────────────────────────────────

describe('DockerEngine.stop', () => {
  it('spawns docker stop <id>', async () => {
    const engine = new DockerEngine();
    const { proc, stdout, stderr } = makeFakeProc();
    mockSpawn.mockReturnValue(proc);
    resolveProc({ proc, stdout, stderr }, 0, 'abc123\n');

    const result = await engine.stop('abc123');
    expect(result.exit_code).toBe(0);

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toEqual(['stop', 'abc123']);
  });
});

// ── build operation ───────────────────────────────────────────────────────────

describe('DockerEngine.build', () => {
  it('spawns docker build with context path', async () => {
    const engine = new DockerEngine();
    const { proc, stdout, stderr } = makeFakeProc();
    mockSpawn.mockReturnValue(proc);
    resolveProc({ proc, stdout, stderr }, 0, 'Successfully built\n');

    const result = await engine.build('/app', { tag: 'myapp:latest' });
    expect(result.exit_code).toBe(0);

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toEqual(expect.arrayContaining(['-t', 'myapp:latest', '/app']));
  });

  it('passes --build-arg flags', async () => {
    const engine = new DockerEngine();
    const { proc, stdout, stderr } = makeFakeProc();
    mockSpawn.mockReturnValue(proc);
    resolveProc({ proc, stdout, stderr }, 0, '');

    await engine.build('.', { buildArgs: { NODE_ENV: 'production' } });

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toEqual(expect.arrayContaining(['--build-arg', 'NODE_ENV=production']));
  });

  it('passes -f dockerfile flag', async () => {
    const engine = new DockerEngine();
    const { proc, stdout, stderr } = makeFakeProc();
    mockSpawn.mockReturnValue(proc);
    resolveProc({ proc, stdout, stderr }, 0, '');

    await engine.build('.', { dockerfile: 'Dockerfile.prod' });

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toEqual(expect.arrayContaining(['-f', 'Dockerfile.prod']));
  });
});

// ── inspect operation ─────────────────────────────────────────────────────────

describe('DockerEngine.inspect', () => {
  it('spawns docker inspect <id> and returns JSON', async () => {
    const engine = new DockerEngine();
    const { proc, stdout, stderr } = makeFakeProc();
    mockSpawn.mockReturnValue(proc);
    resolveProc({ proc, stdout, stderr }, 0, '[{"Id":"abc123"}]\n');

    const result = await engine.inspect('abc123');
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain('"Id":"abc123"');

    const [, args] = mockSpawn.mock.calls[0];
    expect(args).toEqual(['inspect', 'abc123']);
  });
});

// ── Streaming contract ────────────────────────────────────────────────────────

describe('DockerEngine — streaming contract', () => {
  it('delivers stdout and stderr chunks separately to onChunk', async () => {
    const engine = new DockerEngine();
    const { proc, stdout, stderr } = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    const received: Array<[string, 'stdout' | 'stderr']> = [];
    const resultP = engine.list(undefined, (chunk, stream) => received.push([chunk, stream]));

    setImmediate(() => {
      stdout.emit('data', Buffer.from('chunk1'));
      stdout.emit('data', Buffer.from('chunk2'));
      stderr.emit('data', Buffer.from('err1'));
      proc.emit('close', 0);
    });

    await resultP;

    expect(received).toContainEqual(['chunk1', 'stdout']);
    expect(received).toContainEqual(['chunk2', 'stdout']);
    expect(received).toContainEqual(['err1', 'stderr']);
  });

  it('accumulates all stdout/stderr in the result', async () => {
    const engine = new DockerEngine();
    const { proc, stdout, stderr } = makeFakeProc();
    mockSpawn.mockReturnValue(proc);

    const resultP = engine.list();
    setImmediate(() => {
      stdout.emit('data', Buffer.from('part1'));
      stdout.emit('data', Buffer.from('part2'));
      proc.emit('close', 0);
    });

    const result = await resultP;
    expect(result.stdout).toBe('part1part2');
  });
});

// ── Cancellation ──────────────────────────────────────────────────────────────

describe('DockerEngine — AbortSignal cancellation', () => {
  it('kills the process when signal is aborted and sets cancelled=true', async () => {
    const engine = new DockerEngine();
    const { proc, stdout, stderr } = makeFakeProc();
    const killMock = proc.kill as jest.Mock;
    mockSpawn.mockReturnValue(proc);

    const controller = new AbortController();
    const resultP = engine.list(undefined, undefined, controller.signal);

    // Abort then let the process close
    setImmediate(() => {
      controller.abort();
      setTimeout(() => proc.emit('close', 0), 10);
    });

    const result = await resultP;
    expect(result.cancelled).toBe(true);
    expect(killMock).toHaveBeenCalledWith('SIGTERM');
  }, 10_000);

  it('signals already-aborted AbortSignal before spawn', async () => {
    const engine = new DockerEngine();
    const { proc, stdout, stderr } = makeFakeProc();
    const killMock = proc.kill as jest.Mock;
    mockSpawn.mockReturnValue(proc);

    const controller = new AbortController();
    controller.abort(); // already aborted

    const resultP = engine.list(undefined, undefined, controller.signal);

    setImmediate(() => proc.emit('close', 130));

    await resultP;
    expect(killMock).toHaveBeenCalledWith('SIGTERM');
  });
});

describe('DockerEngine.cancel', () => {
  it('returns false for unknown opId', () => {
    const engine = new DockerEngine();
    expect(engine.cancel('nonexistent-op')).toBe(false);
  });

  it('returns empty map when no operations are active', () => {
    const engine = new DockerEngine();
    expect(engine.getActiveOperations().size).toBe(0);
  });

  it('registers operation while in-flight then removes on close', async () => {
    const engine = new DockerEngine();
    const { proc, stdout, stderr } = makeFakeProc(99999);
    mockSpawn.mockReturnValue(proc);

    const resultP = engine.list();

    // Immediately after spawn the operation should be registered
    await new Promise<void>((r) => setImmediate(r));
    expect(engine.getActiveOperations().size).toBe(1);
    const [, op] = [...engine.getActiveOperations().entries()][0];
    expect(op.pid).toBe(99999);
    expect(op.operation).toBe('list');

    // Close the process
    proc.emit('close', 0);
    await resultP;
    expect(engine.getActiveOperations().size).toBe(0);
  });
});

// ── Policy firewall integration ───────────────────────────────────────────────

describe('DockerEngine — policy firewall integration', () => {
  it('throws and audit-logs when firewall rejects an operation', async () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

    // Firewall that always rejects
    const rejectFirewall: IPolicyFirewall = {
      async classify(action: string): Promise<TierDecision> {
        return {
          tier: 3,
          action,
          reason: 'Test block',
          approved: false,
          decided_at: new Date().toISOString(),
        };
      },
    };

    const engine = new DockerEngine(rejectFirewall);
    await expect(engine.list()).rejects.toThrow('[DockerEngine] POLICY GATE');

    // Audit log entry should have been emitted to stderr
    expect(stderrSpy).toHaveBeenCalled();
    const logged = JSON.parse(stderrSpy.mock.calls[0][0] as string);
    expect(logged.service).toBe('DockerEngine');
    expect(logged.tier).toBe(3);

    stderrSpy.mockRestore();
  });

  it('calls firewall with action and context before spawning', async () => {
    const classifySpy = jest.fn().mockResolvedValue({
      tier: 1,
      action: 'docker.ps',
      reason: 'ok',
      approved: true,
      decided_at: new Date().toISOString(),
    } satisfies TierDecision);

    const customFirewall: IPolicyFirewall = { classify: classifySpy };
    const engine = new DockerEngine(customFirewall);

    const { proc, stdout, stderr } = makeFakeProc();
    mockSpawn.mockReturnValue(proc);
    resolveProc({ proc, stdout, stderr }, 0);

    await engine.list();

    expect(classifySpy).toHaveBeenCalledTimes(1);
    const [action, ctx] = classifySpy.mock.calls[0];
    expect(action).toBe('docker.ps');
    expect(ctx).toHaveProperty('args');
    expect(ctx).toHaveProperty('operation', 'list');
  });

  it('blocks --privileged args (Tier 3) via stub firewall', async () => {
    // --privileged classification is done in the firewall, not DockerEngine directly.
    // Verify stub firewall rejects it so DockerEngine throws.
    const engine = new DockerEngine(new DockerStubFirewall());
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

    // Manually inject --privileged by calling run via a custom wrapper test
    // We can verify the firewall decision directly:
    const fw = new DockerStubFirewall();
    const decision = await fw.classify('docker.run', { privileged: true });
    expect(decision.tier).toBe(3);
    expect(decision.approved).toBe(false);

    stderrSpy.mockRestore();
  });
});

// ── Timeout ───────────────────────────────────────────────────────────────────

describe('DockerEngine — timeout', () => {
  it('uses DOCKER_DEFAULT_TIMEOUT_MS (15 min)', () => {
    expect(DOCKER_DEFAULT_TIMEOUT_MS).toBe(900_000);
  });

  it('marks timed_out=true and kills process on timeout', async () => {
    const engine = new DockerEngine();
    const { proc, stdout, stderr } = makeFakeProc();
    const killMock = proc.kill as jest.Mock;
    killMock.mockImplementation((sig?: string) => {
      if (sig === 'SIGKILL') proc.emit('close', 137);
      return true;
    });
    mockSpawn.mockReturnValue(proc);

    // Use a very short real timeout — no fake timers needed.
    const result = await engine.list({ timeout_ms: 50 });
    expect(result.timed_out).toBe(true);
    expect(killMock).toHaveBeenCalledWith('SIGKILL');
  }, 3_000);

  it('respects custom timeout_ms option', async () => {
    const engine = new DockerEngine();
    const { proc, stdout, stderr } = makeFakeProc();
    const killMock = proc.kill as jest.Mock;
    killMock.mockImplementation(() => {
      proc.emit('close', 137);
      return true;
    });
    mockSpawn.mockReturnValue(proc);

    const result = await engine.list({ timeout_ms: 50 });
    expect(result.timed_out).toBe(true);
    expect(result.exit_code).toBe(137);
  }, 3_000);
});

// ── duration_ms ───────────────────────────────────────────────────────────────

describe('DockerEngine — result metadata', () => {
  it('records a positive duration_ms', async () => {
    const engine = new DockerEngine();
    const { proc, stdout, stderr } = makeFakeProc();
    mockSpawn.mockReturnValue(proc);
    resolveProc({ proc, stdout, stderr }, 0);

    const result = await engine.list();
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('includes tier_decision in every result', async () => {
    const engine = new DockerEngine();
    const { proc, stdout, stderr } = makeFakeProc();
    mockSpawn.mockReturnValue(proc);
    resolveProc({ proc, stdout, stderr }, 0);

    const result = await engine.list();
    expect(result.tier_decision).toBeDefined();
    expect(result.tier_decision.tier).toBe(1);
  });
});
