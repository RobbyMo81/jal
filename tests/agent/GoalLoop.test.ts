// Co-authored by FORGE (Session: forge-20260327063704-3049883)
// tests/agent/GoalLoop.test.ts — JAL-011 GoalLoop unit tests

import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { GoalLoop } from '../../src/apex/agent/GoalLoop';
import { ApexRuntime } from '../../src/apex/runtime/ApexRuntime';
import { ProviderGateway, IProviderAdapter } from '../../src/apex/auth/ProviderGateway';
import { AuthManager } from '../../src/apex/auth/AuthManager';
import { MemoryKeychain } from '../../src/apex/auth/MemoryKeychain';
import { NoOpAuditLog } from '../../src/apex/policy/AuditLog';
import { GatewayMessage, CompletionOptions, CompletionResult } from '../../src/apex/types';

// ── Helpers ────────────────────────────────────────────────────────────────────

let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-goalloop-test-'));
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

/** Capture all onChunk calls into a string. */
function captureChunks(): { onChunk: (t: string) => void; getOutput: () => string } {
  let buf = '';
  return {
    onChunk: (t) => { buf += t; },
    getOutput: () => buf,
  };
}

/** Build a ProviderGateway that returns the given JSON string for every complete() call. */
function buildGateway(response: string, auditLog = new NoOpAuditLog()): ProviderGateway {
  const keychain = new MemoryKeychain();
  const authManager = new AuthManager({ keychain, audit: auditLog });

  const adapter: IProviderAdapter = {
    provider: 'test',
    async complete(
      _msgs: GatewayMessage[],
      model: string,
      _token: string,
      _opts: CompletionOptions
    ): Promise<CompletionResult> {
      return { content: response, model, provider: 'test' };
    },
    async stream(
      _msgs: GatewayMessage[],
      model: string,
      _token: string,
      _opts: CompletionOptions,
      onChunk: (c: string) => void
    ): Promise<CompletionResult> {
      onChunk(response);
      return { content: response, model, provider: 'test' };
    },
  };

  const gw = new ProviderGateway({ authManager, config: { provider: 'test', model: 'm' } });
  gw.registerAdapter(adapter);

  // Pre-load token so getToken('test') resolves
  (async () => {
    await authManager.login('test', 'test-token', { auth_method: 'cli-hook', expires_at: null });
  })();

  return gw;
}

/** Build a runtime with a no-op audit log and temp stateDir. */
async function buildRuntime(stateDir: string, gateway?: ProviderGateway): Promise<ApexRuntime> {
  const runtime = new ApexRuntime({
    auditLog: new NoOpAuditLog(),
    stateDir,
    providerGateway: gateway,
  });
  await runtime.start();
  return runtime;
}

// ── parseSteps (via run) ───────────────────────────────────────────────────────

describe('GoalLoop — goal decomposition', () => {
  it('parses valid JSON step array from LLM response', async () => {
    const steps = JSON.stringify([
      { id: 'step-1', description: 'Echo hello', command: 'echo hello', tool: 'shell' },
    ]);
    const gw = buildGateway(steps);
    const runtime = await buildRuntime(stateDir, gw);
    const { onChunk, getOutput } = captureChunks();

    const loop = new GoalLoop(runtime, gw, { onChunk, stateDir });
    await loop.run('say hello');

    const out = getOutput();
    expect(out).toContain('Echo hello');
    await runtime.stop();
  });

  it('handles LLM response with surrounding text (extracts JSON array)', async () => {
    const response =
      'Here are the steps:\n' +
      JSON.stringify([
        { id: 'step-1', description: 'List files', command: 'ls', tool: 'shell' },
      ]) +
      '\nDone.';
    const gw = buildGateway(response);
    const runtime = await buildRuntime(stateDir, gw);
    const { onChunk, getOutput } = captureChunks();

    const loop = new GoalLoop(runtime, gw, { onChunk, stateDir });
    await loop.run('list files');

    expect(getOutput()).toContain('List files');
    await runtime.stop();
  });

  it('emits error message when LLM returns non-JSON response', async () => {
    const gw = buildGateway('Sorry, I cannot help with that.');
    const runtime = await buildRuntime(stateDir, gw);
    const { onChunk, getOutput } = captureChunks();

    const loop = new GoalLoop(runtime, gw, { onChunk, stateDir });
    await loop.run('some goal');

    expect(getOutput()).toContain('Failed to decompose goal');
    await runtime.stop();
  });

  it('emits message when LLM returns empty array', async () => {
    const gw = buildGateway('[]');
    const runtime = await buildRuntime(stateDir, gw);
    const { onChunk, getOutput } = captureChunks();

    const loop = new GoalLoop(runtime, gw, { onChunk, stateDir });
    await loop.run('empty goal');

    expect(getOutput()).toContain('No steps produced');
    await runtime.stop();
  });
});

// ── Tier classification ────────────────────────────────────────────────────────

describe('GoalLoop — Tier 3 abort', () => {
  it('aborts loop and never executes a Tier 3 command', async () => {
    // sudo is Tier 3
    const steps = JSON.stringify([
      { id: 'step-1', description: 'Run sudo', command: 'sudo ls', tool: 'shell' },
    ]);
    const gw = buildGateway(steps);
    const runtime = await buildRuntime(stateDir, gw);
    const { onChunk, getOutput } = captureChunks();

    const loop = new GoalLoop(runtime, gw, { onChunk, stateDir });
    await loop.run('escalate privileges');

    const out = getOutput();
    expect(out).toContain('TIER 3 BLOCKED');
    expect(out).toContain('Goal loop aborted');
    await runtime.stop();
  });
});

describe('GoalLoop — Tier 1 auto-approve', () => {
  it('executes Tier 1 command without approval prompt', async () => {
    const steps = JSON.stringify([
      { id: 'step-1', description: 'Echo hello', command: 'echo hello', tool: 'shell' },
    ]);
    const gw = buildGateway(steps);
    const runtime = await buildRuntime(stateDir, gw);
    const { onChunk, getOutput } = captureChunks();

    const loop = new GoalLoop(runtime, gw, { onChunk, stateDir });
    await loop.run('print hello');

    const out = getOutput();
    expect(out).toContain('OK');
    expect(out).not.toContain('TIER 3');
    await runtime.stop();
  });
});

// ── Step failure and retry ─────────────────────────────────────────────────────

describe('GoalLoop — step failure handling', () => {
  it('reports failure after 3 attempts when command consistently fails', async () => {
    // A command that always exits non-zero
    const steps = JSON.stringify([
      { id: 'step-1', description: 'Fail command', command: 'false', tool: 'shell' },
    ]);
    // Second and third calls return the self-correction prompt response
    let callCount = 0;
    const keychain = new MemoryKeychain();
    const auditLog = new NoOpAuditLog();
    const authManager = new AuthManager({ keychain, audit: auditLog });
    await authManager.login('test', 'tok', { auth_method: 'cli-hook', expires_at: null });

    const adapter: IProviderAdapter = {
      provider: 'test',
      async complete(_msgs: GatewayMessage[], model: string): Promise<CompletionResult> {
        callCount++;
        if (callCount === 1) {
          // decompose
          return { content: JSON.stringify([
            { id: 'step-1', description: 'Fail command', command: 'false', tool: 'shell' },
          ]), model, provider: 'test' };
        }
        // self-correct / recommendation — just return same command
        return { content: 'false', model, provider: 'test' };
      },
      async stream(
        _m: GatewayMessage[], model: string, _t: string, _o: CompletionOptions,
        onChunk: (c: string) => void
      ): Promise<CompletionResult> {
        onChunk('false');
        return { content: 'false', model, provider: 'test' };
      },
    };

    const gw = new ProviderGateway({ authManager, config: { provider: 'test', model: 'm' } });
    gw.registerAdapter(adapter);

    const runtime = await buildRuntime(stateDir, gw);
    const { onChunk, getOutput } = captureChunks();

    const loop = new GoalLoop(runtime, gw, { onChunk, stateDir });
    await loop.run('run a failing command');

    const out = getOutput();
    expect(out).toContain('failed after 3 attempts');
    expect(out).toContain('What was tried');
    expect(out).toContain('Last error');
    await runtime.stop();
  });

  it('succeeds on retry when self-correction provides working command', async () => {
    let callCount = 0;
    const keychain = new MemoryKeychain();
    const auditLog = new NoOpAuditLog();
    const authManager = new AuthManager({ keychain, audit: auditLog });
    await authManager.login('test', 'tok', { auth_method: 'cli-hook', expires_at: null });

    const adapter: IProviderAdapter = {
      provider: 'test',
      async complete(_msgs: GatewayMessage[], model: string): Promise<CompletionResult> {
        callCount++;
        if (callCount === 1) {
          // Decompose: initial command fails
          return { content: JSON.stringify([
            { id: 'step-1', description: 'Print hi', command: 'false', tool: 'shell' },
          ]), model, provider: 'test' };
        }
        // Self-correction: return a working command
        return { content: 'echo hi', model, provider: 'test' };
      },
      async stream(
        _m: GatewayMessage[], model: string, _t: string, _o: CompletionOptions,
        onChunk: (c: string) => void
      ): Promise<CompletionResult> {
        onChunk('echo hi');
        return { content: 'echo hi', model, provider: 'test' };
      },
    };

    const gw = new ProviderGateway({ authManager, config: { provider: 'test', model: 'm' } });
    gw.registerAdapter(adapter);

    const runtime = await buildRuntime(stateDir, gw);
    const { onChunk, getOutput } = captureChunks();

    const loop = new GoalLoop(runtime, gw, { onChunk, stateDir });
    await loop.run('print something');

    const out = getOutput();
    // Should succeed after correction
    expect(out).toContain('OK');
    expect(out).toContain('All steps completed');
    await runtime.stop();
  });
});

// ── Self-correction prompt quality ────────────────────────────────────────────

describe('GoalLoop — self-correction prompt', () => {
  it('includes SAFETY GATE note when error is a safety gate rejection', async () => {
    const capturedPrompts: string[] = [];
    let callCount = 0;
    const keychain = new MemoryKeychain();
    const auditLog = new NoOpAuditLog();
    const authManager = new AuthManager({ keychain, audit: auditLog });
    await authManager.login('test', 'tok', { auth_method: 'cli-hook', expires_at: null });

    const adapter: IProviderAdapter = {
      provider: 'test',
      async complete(msgs: GatewayMessage[], model: string): Promise<CompletionResult> {
        callCount++;
        // Record all prompts sent for self-correction (calls 2+)
        const content = (msgs[0] as GatewayMessage).content;
        if (typeof content === 'string') capturedPrompts.push(content);

        if (callCount === 1) {
          // Decompose — return a multi-line command that will be rejected by safety gate
          return { content: JSON.stringify([
            { id: 's1', description: 'Count files', command: 'for f in $(ls); do echo $f; done', tool: 'shell' },
          ]), model, provider: 'test' };
        }
        // Correction / recommendation attempts — return a single-line command
        return { content: 'ls | wc -l', model, provider: 'test' };
      },
      async stream(
        _m: GatewayMessage[], model: string, _t: string, _o: CompletionOptions,
        onChunk: (c: string) => void
      ): Promise<CompletionResult> {
        onChunk('ls | wc -l');
        return { content: 'ls | wc -l', model, provider: 'test' };
      },
    };

    const gw = new ProviderGateway({ authManager, config: { provider: 'test', model: 'm' } });
    gw.registerAdapter(adapter);
    const runtime = await buildRuntime(stateDir, gw);
    const loop = new GoalLoop(runtime, gw, { onChunk: () => {}, stateDir });
    await loop.run('count files');

    // At least one correction prompt must include SAFETY GATE language
    const safetyPrompts = capturedPrompts.filter(p => p.includes('SAFETY GATE'));
    expect(safetyPrompts.length).toBeGreaterThan(0);
    expect(safetyPrompts[0]).toContain('single-line');
    await runtime.stop();
  });

  it('includes single-line constraint in all correction prompts regardless of error type', async () => {
    const capturedPrompts: string[] = [];
    let callCount = 0;
    const keychain = new MemoryKeychain();
    const auditLog = new NoOpAuditLog();
    const authManager = new AuthManager({ keychain, audit: auditLog });
    await authManager.login('test', 'tok', { auth_method: 'cli-hook', expires_at: null });

    const adapter: IProviderAdapter = {
      provider: 'test',
      async complete(msgs: GatewayMessage[], model: string): Promise<CompletionResult> {
        callCount++;
        const content = (msgs[0] as GatewayMessage).content;
        if (typeof content === 'string') capturedPrompts.push(content);
        if (callCount === 1) {
          return { content: JSON.stringify([
            { id: 's1', description: 'Failing step', command: 'false', tool: 'shell' },
          ]), model, provider: 'test' };
        }
        return { content: 'true', model, provider: 'test' };
      },
      async stream(
        _m: GatewayMessage[], model: string, _t: string, _o: CompletionOptions,
        onChunk: (c: string) => void
      ): Promise<CompletionResult> {
        onChunk('true');
        return { content: 'true', model, provider: 'test' };
      },
    };

    const gw = new ProviderGateway({ authManager, config: { provider: 'test', model: 'm' } });
    gw.registerAdapter(adapter);
    const runtime = await buildRuntime(stateDir, gw);
    const loop = new GoalLoop(runtime, gw, { onChunk: () => {}, stateDir });
    await loop.run('run a command');

    // Every correction prompt must include the single-line constraint
    const correctionPrompts = capturedPrompts.slice(1); // skip decompose call
    expect(correctionPrompts.length).toBeGreaterThan(0);
    for (const p of correctionPrompts) {
      expect(p).toMatch(/single-line/i);
    }
    await runtime.stop();
  });
});

// ── Checkpointing ──────────────────────────────────────────────────────────────

describe('GoalLoop — checkpointing', () => {
  it('writes a checkpoint file after each completed step', async () => {
    const steps = JSON.stringify([
      { id: 'step-1', description: 'Echo a', command: 'echo a', tool: 'shell' },
      { id: 'step-2', description: 'Echo b', command: 'echo b', tool: 'shell' },
    ]);
    const gw = buildGateway(steps);
    const runtime = await buildRuntime(stateDir, gw);
    const { onChunk } = captureChunks();

    const loop = new GoalLoop(runtime, gw, { onChunk, stateDir });
    await loop.run('echo twice');

    // Latest checkpoint pointer should exist
    const latestPath = path.join(stateDir, 'checkpoints', 'latest.json');
    expect(fs.existsSync(latestPath)).toBe(true);
    await runtime.stop();
  });
});

// ── Episodic trace ─────────────────────────────────────────────────────────────

describe('GoalLoop — execution trace', () => {
  it('writes execution trace to episodic memory after a run', async () => {
    const steps = JSON.stringify([
      { id: 'step-1', description: 'Echo trace', command: 'echo trace', tool: 'shell' },
    ]);
    const gw = buildGateway(steps);
    const runtime = await buildRuntime(stateDir, gw);
    const { onChunk } = captureChunks();

    const loop = new GoalLoop(runtime, gw, { onChunk, stateDir });
    await loop.run('test trace write');

    // Episodic memory directory should contain at least one file
    const episodicDir = path.join(stateDir, 'memory', 'episodic');
    const files = fs.existsSync(episodicDir) ? fs.readdirSync(episodicDir) : [];
    expect(files.length).toBeGreaterThan(0);
    await runtime.stop();
  });
});

// ── Summary output ─────────────────────────────────────────────────────────────

describe('GoalLoop — summary', () => {
  it('prints a plain-English completion summary', async () => {
    const steps = JSON.stringify([
      { id: 'step-1', description: 'Echo done', command: 'echo done', tool: 'shell' },
    ]);
    const gw = buildGateway(steps);
    const runtime = await buildRuntime(stateDir, gw);
    const { onChunk, getOutput } = captureChunks();

    const loop = new GoalLoop(runtime, gw, { onChunk, stateDir });
    await loop.run('print done');

    const out = getOutput();
    expect(out).toContain('Goal Loop Summary');
    expect(out).toContain('Completed:');
    expect(out).toContain('All steps completed');
    await runtime.stop();
  });

  it('summary shows abort reason when loop was aborted', async () => {
    const steps = JSON.stringify([
      { id: 'step-1', description: 'Escalate', command: 'sudo rm -rf /', tool: 'shell' },
    ]);
    const gw = buildGateway(steps);
    const runtime = await buildRuntime(stateDir, gw);
    const { onChunk, getOutput } = captureChunks();

    const loop = new GoalLoop(runtime, gw, { onChunk, stateDir });
    await loop.run('destroy everything');

    const out = getOutput();
    expect(out).toContain('Aborted');
    await runtime.stop();
  });
});

// ── Repl goal command ─────────────────────────────────────────────────────────

describe('Repl — goal command', () => {
  it('is listed in help output', async () => {
    const { Repl } = await import('../../src/apex/repl/Repl');
    const { Writable } = await import('stream');
    let buf = '';
    const stream = new Writable({ write(chunk, _, cb) { buf += chunk.toString(); cb(); } });
    const repl = new Repl({ output: stream, runtimeOptions: { auditLog: new NoOpAuditLog(), stateDir } });
    await repl.dispatch('help');
    expect(buf).toContain('goal');
    await repl.runtime.stop();
  });

  it('dispatch returns false (keeps REPL open) for goal command', async () => {
    const { Repl } = await import('../../src/apex/repl/Repl');
    const { Writable } = await import('stream');
    let buf = '';
    const stream = new Writable({ write(chunk, _, cb) { buf += chunk.toString(); cb(); } });
    const repl = new Repl({ output: stream, runtimeOptions: { auditLog: new NoOpAuditLog(), stateDir } });
    const result = await repl.dispatch('goal list files in /tmp');
    expect(result).toBe(false);
    await repl.runtime.stop();
  });

  it('prints usage when goal command has no argument', async () => {
    const { Repl } = await import('../../src/apex/repl/Repl');
    const { Writable } = await import('stream');
    let buf = '';
    const stream = new Writable({ write(chunk, _, cb) { buf += chunk.toString(); cb(); } });
    const repl = new Repl({ output: stream, runtimeOptions: { auditLog: new NoOpAuditLog(), stateDir } });
    await repl.dispatch('goal');
    expect(buf).toContain('Usage: goal');
    await repl.runtime.stop();
  });
});
