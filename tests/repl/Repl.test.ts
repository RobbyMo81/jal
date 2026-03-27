// Co-authored by FORGE (Session: forge-20260326213245-2999721)
// tests/repl/Repl.test.ts — JAL-009 REPL dispatch, tier enforcement, streaming

import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { Readable, Writable } from 'stream';
import { Repl } from '../../src/apex/repl/Repl';
import { NoOpAuditLog, CapturingAuditLog } from '../../src/apex/policy/AuditLog';

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Collect all writes to a writable stream into a single string. */
function captureOutput(): { stream: Writable; getOutput: () => string } {
  let buf = '';
  const stream = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      buf += chunk.toString();
      cb();
    },
  });
  return { stream, getOutput: () => buf };
}

/**
 * Build a Readable that emits lines one at a time.
 * The readable ends after all lines are consumed.
 */
function makeInput(lines: string[]): Readable {
  return Readable.from(lines.map(l => l + '\n').join(''));
}

let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-repl-test-'));
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

// ── dispatch() tests (unit-level, no I/O loop) ─────────────────────────────────

describe('Repl.dispatch — help', () => {
  it('prints available commands', async () => {
    const { stream, getOutput } = captureOutput();
    const repl = new Repl({
      output: stream,
      runtimeOptions: { auditLog: new NoOpAuditLog(), stateDir },
    });
    await repl.dispatch('help');
    expect(getOutput()).toContain('run <command>');
    expect(getOutput()).toContain('docker');
    expect(getOutput()).toContain('status');
    expect(getOutput()).toContain('exit');
    await repl.runtime.stop();
  });
});

describe('Repl.dispatch — status', () => {
  it('prints heartbeat and active process info', async () => {
    const { stream, getOutput } = captureOutput();
    const repl = new Repl({
      output: stream,
      runtimeOptions: { auditLog: new NoOpAuditLog(), stateDir },
    });
    await repl.dispatch('status');
    expect(getOutput()).toContain('Heartbeat:');
    expect(getOutput()).toContain('Active shell:');
    expect(getOutput()).toContain('Short-term mem:');
    await repl.runtime.stop();
  });

  it('logs status action to audit log', async () => {
    const audit = new CapturingAuditLog();
    const { stream } = captureOutput();
    const repl = new Repl({
      output: stream,
      runtimeOptions: { auditLog: audit, stateDir },
    });
    await repl.dispatch('status');
    expect(audit.entries.some(e => e.action === 'repl.status')).toBe(true);
    await repl.runtime.stop();
  });
});

describe('Repl.dispatch — exit', () => {
  it('returns true (signals shutdown)', async () => {
    const { stream } = captureOutput();
    const repl = new Repl({
      output: stream,
      runtimeOptions: { auditLog: new NoOpAuditLog(), stateDir },
    });
    const result = await repl.dispatch('exit');
    expect(result).toBe(true);
    await repl.runtime.stop();
  });
});

describe('Repl.dispatch — unknown command', () => {
  it('prints unknown command message', async () => {
    const { stream, getOutput } = captureOutput();
    const repl = new Repl({
      output: stream,
      runtimeOptions: { auditLog: new NoOpAuditLog(), stateDir },
    });
    await repl.dispatch('foobar');
    expect(getOutput()).toContain('Unknown command');
    await repl.runtime.stop();
  });
});

describe('Repl.dispatch — run (Tier 1)', () => {
  it('executes echo and streams output', async () => {
    const { stream, getOutput } = captureOutput();
    const repl = new Repl({
      output: stream,
      runtimeOptions: { auditLog: new NoOpAuditLog(), stateDir },
    });
    await repl.dispatch('run echo hello_apex');
    expect(getOutput()).toContain('hello_apex');
    expect(getOutput()).toContain('[exit: 0]');
    await repl.runtime.stop();
  });

  it('logs run action before execution', async () => {
    const audit = new CapturingAuditLog();
    const { stream } = captureOutput();
    const repl = new Repl({
      output: stream,
      runtimeOptions: { auditLog: audit, stateDir },
    });
    await repl.dispatch('run echo test');
    expect(audit.entries.some(e => e.action === 'repl.run')).toBe(true);
    await repl.runtime.stop();
  });

  it('shows exit code on non-zero exit', async () => {
    const { stream, getOutput } = captureOutput();
    const repl = new Repl({
      output: stream,
      runtimeOptions: { auditLog: new NoOpAuditLog(), stateDir },
    });
    await repl.dispatch('run exit 42');
    expect(getOutput()).toContain('[exit: 42]');
    await repl.runtime.stop();
  });

  it('Tier 3 sudo prints TIER 3 BLOCKED without approval prompt', async () => {
    const { stream, getOutput } = captureOutput();
    const repl = new Repl({
      output: stream,
      runtimeOptions: { auditLog: new NoOpAuditLog(), stateDir },
    });
    await repl.dispatch('run sudo ls');
    // Should be blocked with SAFETY GATE message — no approval prompt
    const out = getOutput();
    expect(out).not.toContain('[TIER 2]');
    // ShellEngine blocks sudo before it even reaches the firewall
    expect(out).toContain('SAFETY GATE');
    await repl.runtime.stop();
  });

  it('prints error message if run is missing a command', async () => {
    const { stream, getOutput } = captureOutput();
    const repl = new Repl({
      output: stream,
      runtimeOptions: { auditLog: new NoOpAuditLog(), stateDir },
    });
    await repl.dispatch('run');
    expect(getOutput()).toContain('Usage: run');
    await repl.runtime.stop();
  });
});

describe('Repl.dispatch — docker', () => {
  it('prints usage when no subcommand given', async () => {
    const { stream, getOutput } = captureOutput();
    const repl = new Repl({
      output: stream,
      runtimeOptions: { auditLog: new NoOpAuditLog(), stateDir },
    });
    await repl.dispatch('docker');
    expect(getOutput()).toContain('Usage: docker');
    await repl.runtime.stop();
  });

  it('prints usage for docker start with no container id', async () => {
    const { stream, getOutput } = captureOutput();
    const repl = new Repl({
      output: stream,
      runtimeOptions: { auditLog: new NoOpAuditLog(), stateDir },
    });
    await repl.dispatch('docker start');
    expect(getOutput()).toContain('Usage: docker start');
    await repl.runtime.stop();
  });

  it('prints unknown subcommand message', async () => {
    const { stream, getOutput } = captureOutput();
    const repl = new Repl({
      output: stream,
      runtimeOptions: { auditLog: new NoOpAuditLog(), stateDir },
    });
    await repl.dispatch('docker bogus');
    expect(getOutput()).toContain('Unknown docker subcommand');
    await repl.runtime.stop();
  });
});

describe('Repl.dispatch — Tier 2 approval', () => {
  it('calls onApprovalRequired and resolves with approval', async () => {
    const { stream, getOutput } = captureOutput();
    const audit = new CapturingAuditLog();

    // We intercept the approval callback directly via the firewall
    let capturedApprovalId: string | undefined;
    const input = makeInput(['']); // dummy input (readline won't actually prompt in this test)

    const repl = new Repl({
      input,
      output: stream,
      runtimeOptions: {
        auditLog: audit,
        stateDir,
        onApprovalRequired: (token) => {
          capturedApprovalId = token.id;
          // Immediately approve — simulates user typing 'y'
          repl.runtime.approvalService.resolve(token.id, true);
        },
      },
    });

    // 'rm /tmp' triggers Tier 2 (rm is a Tier 2 command)
    const dispatchPromise = repl.dispatch('run rm /tmp/apex-test-nonexistent-file');
    await dispatchPromise;

    expect(capturedApprovalId).toBeDefined();
    await repl.runtime.stop();
  });

  it('Tier 2 denial prevents execution and prints Denied', async () => {
    const { stream, getOutput } = captureOutput();

    const repl = new Repl({
      output: stream,
      runtimeOptions: {
        auditLog: new NoOpAuditLog(),
        stateDir,
        onApprovalRequired: (token) => {
          // Immediately deny
          repl.runtime.approvalService.resolve(token.id, false);
        },
      },
    });

    await repl.dispatch('run rm /tmp/apex-test-nonexistent-file');
    // The approval was denied — the shell engine throws a POLICY GATE error
    const out = getOutput();
    expect(out).toContain('POLICY GATE');
    await repl.runtime.stop();
  });
});

describe('Repl — audit logging', () => {
  it('logs every REPL command before execution', async () => {
    const audit = new CapturingAuditLog();
    const { stream } = captureOutput();
    const repl = new Repl({
      output: stream,
      runtimeOptions: { auditLog: audit, stateDir },
    });

    await repl.dispatch('run echo audit-check');
    await repl.dispatch('status');
    await repl.dispatch('help');

    const actions = audit.entries.map(e => e.action);
    expect(actions).toContain('repl.run');
    expect(actions).toContain('repl.status');
    await repl.runtime.stop();
  });
});
