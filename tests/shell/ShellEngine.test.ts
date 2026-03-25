// Co-authored by FORGE (Session: forge-20260324215726-1658598)
// tests/shell/ShellEngine.test.ts — JAL-001 unit tests

import { ShellEngine, DEFAULT_TIMEOUT_MS } from '../../src/apex/shell/ShellEngine';

// ── Static safety gate tests ──────────────────────────────────────────────────

describe('ShellEngine.checkInjection', () => {
  it('allows clean commands', () => {
    expect(() => ShellEngine.checkInjection('echo hello')).not.toThrow();
    expect(() => ShellEngine.checkInjection('ls -la')).not.toThrow();
    expect(() => ShellEngine.checkInjection('cat /etc/hostname')).not.toThrow();
  });

  it('allows pipes and redirects (legitimate shell constructs)', () => {
    expect(() => ShellEngine.checkInjection('ls | grep foo')).not.toThrow();
    expect(() => ShellEngine.checkInjection('echo hello > /tmp/out')).not.toThrow();
  });

  it('rejects semicolon command chaining', () => {
    expect(() => ShellEngine.checkInjection('echo hello; rm -rf /')).toThrow(
      '[ShellEngine] SAFETY GATE'
    );
  });

  it('rejects backtick command substitution', () => {
    expect(() => ShellEngine.checkInjection('echo `id`')).toThrow('[ShellEngine] SAFETY GATE');
  });

  it('rejects $() command substitution', () => {
    expect(() => ShellEngine.checkInjection('echo $(id)')).toThrow('[ShellEngine] SAFETY GATE');
  });

  it('rejects ${} variable expansion used for injection', () => {
    expect(() => ShellEngine.checkInjection('echo ${IFS}cat${IFS}/etc/passwd')).toThrow(
      '[ShellEngine] SAFETY GATE'
    );
  });

  it('rejects newline injection', () => {
    expect(() => ShellEngine.checkInjection('echo hello\nrm -rf /')).toThrow(
      '[ShellEngine] SAFETY GATE'
    );
  });
});

describe('ShellEngine.checkSudo', () => {
  it('allows normal commands', () => {
    expect(() => ShellEngine.checkSudo('echo hello')).not.toThrow();
    expect(() => ShellEngine.checkSudo('ls -la')).not.toThrow();
  });

  it('blocks sudo at the start of a command', () => {
    expect(() => ShellEngine.checkSudo('sudo rm -rf /')).toThrow('[ShellEngine] SAFETY GATE');
  });

  it('blocks sudo after whitespace (e.g. env injection)', () => {
    expect(() => ShellEngine.checkSudo('VAR=1 sudo bash')).toThrow('[ShellEngine] SAFETY GATE');
  });

  it('does not false-positive on "pseudocode" or "sudoku"', () => {
    expect(() => ShellEngine.checkSudo('echo pseudocode')).not.toThrow();
    expect(() => ShellEngine.checkSudo('echo sudoku')).not.toThrow();
  });
});

// ── Shell resolution ──────────────────────────────────────────────────────────

describe('ShellEngine.resolveShell', () => {
  it('resolves bash', () => {
    const { bin, args } = ShellEngine.resolveShell('bash', 'echo hi');
    expect(bin).toBe('bash');
    expect(args).toEqual(['-c', 'echo hi']);
  });

  it('resolves zsh', () => {
    const { bin, args } = ShellEngine.resolveShell('zsh', 'echo hi');
    expect(bin).toBe('zsh');
    expect(args).toEqual(['-c', 'echo hi']);
  });

  it('resolves powershell to pwsh', () => {
    const { bin, args } = ShellEngine.resolveShell('powershell', 'echo hi');
    expect(bin).toBe('pwsh');
    expect(args).toContain('-NonInteractive');
    expect(args).toContain('echo hi');
  });
});

// ── exec — integration tests (real child_process.spawn, bash required) ────────

describe('ShellEngine#exec', () => {
  let engine: ShellEngine;

  beforeEach(() => {
    engine = new ShellEngine();
  });

  it('runs a simple command and returns stdout', async () => {
    const result = await engine.exec('echo hello');
    expect(result.exit_code).toBe(0);
    expect(result.stdout.trim()).toBe('hello');
    expect(result.timed_out).toBe(false);
  });

  it('captures stderr separately', async () => {
    const result = await engine.exec('echo errout >&2');
    expect(result.exit_code).toBe(0);
    expect(result.stderr.trim()).toBe('errout');
  });

  it('reflects non-zero exit codes', async () => {
    const result = await engine.exec('exit 42');
    expect(result.exit_code).toBe(42);
  });

  it('streams chunks incrementally via onChunk callback', async () => {
    const chunks: Array<{ text: string; stream: 'stdout' | 'stderr' }> = [];
    await engine.exec(
      'echo line1',
      {},
      (text, stream) => chunks.push({ text, stream })
    );
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.some(c => c.stream === 'stdout' && c.text.includes('line1'))).toBe(true);
  });

  it('records PID and outputRef in active executions during run', async () => {
    let capturedExecId: string | undefined;
    const resultPromise = engine.exec('sleep 0.1');
    // Give spawn a tick to register
    await new Promise(r => setImmediate(r));
    const active = engine.getActiveExecutions();
    expect(active.size).toBe(1);
    const [id, entry] = [...active.entries()][0];
    capturedExecId = id;
    expect(entry.pid).toBeGreaterThan(0);
    expect(entry.outputRef).toMatch(/^exec-/);
    expect(entry.cancelled).toBe(false);
    await resultPromise;
    // Cleaned up after completion
    expect(engine.getActiveExecutions().size).toBe(0);
  });

  it('cancels a running command via AbortSignal', async () => {
    const controller = new AbortController();
    const resultPromise = engine.exec('sleep 30', {}, undefined, controller.signal);
    await new Promise(r => setTimeout(r, 50));
    controller.abort();
    const result = await resultPromise;
    // Process was killed; exit code will be non-zero (SIGTERM/SIGKILL)
    expect(result.exit_code).not.toBe(0);
  }, 10_000);

  it('marks execution as cancelled in the active record when aborted', async () => {
    const controller = new AbortController();
    const resultPromise = engine.exec('sleep 30', {}, undefined, controller.signal);
    // Wait for spawn
    await new Promise(r => setImmediate(r));
    const [, entry] = [...engine.getActiveExecutions().entries()][0];
    controller.abort();
    expect(entry.cancelled).toBe(true);
    await resultPromise;
  }, 10_000);

  it('times out after the specified timeout_ms', async () => {
    const result = await engine.exec('sleep 10', { timeout_ms: 100 });
    expect(result.timed_out).toBe(true);
    expect(result.exit_code).not.toBe(0);
  }, 5_000);

  it('uses the DEFAULT_TIMEOUT_MS constant (900000ms = 15 min)', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(900_000);
  });

  it('rejects commands containing sudo', async () => {
    await expect(engine.exec('sudo ls')).rejects.toThrow('[ShellEngine] SAFETY GATE');
  });

  it('rejects commands containing injection metacharacters', async () => {
    await expect(engine.exec('echo hello; echo world')).rejects.toThrow(
      '[ShellEngine] SAFETY GATE'
    );
  });

  it('respects the cwd option', async () => {
    const result = await engine.exec('pwd', { cwd: '/tmp' });
    expect(result.stdout.trim()).toBe('/tmp');
  });

  it('respects the env option', async () => {
    const result = await engine.exec('echo $MY_VAR', { env: { MY_VAR: 'forge-test' } });
    expect(result.stdout.trim()).toBe('forge-test');
  });

  it('includes duration_ms in result', async () => {
    const result = await engine.exec('echo timing');
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });
});
