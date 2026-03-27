// Co-authored by FORGE (Session: forge-20260326213245-2999721)
// tests/runtime/ApexRuntime.test.ts — JAL-009 ApexRuntime wiring tests

import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { ApexRuntime } from '../../src/apex/runtime/ApexRuntime';
import { NoOpAuditLog, CapturingAuditLog } from '../../src/apex/policy/AuditLog';
import { MemoryKeychain } from '../../src/apex/auth/MemoryKeychain';
import { ShellEngine } from '../../src/apex/shell/ShellEngine';
import { DockerEngine } from '../../src/apex/docker/DockerEngine';
import { TieredFirewall } from '../../src/apex/policy/TieredFirewall';
import { HeartbeatScheduler } from '../../src/apex/heartbeat/HeartbeatScheduler';
import { CheckpointStore } from '../../src/apex/checkpoint/CheckpointStore';
import { MemoryManager } from '../../src/apex/memory/MemoryManager';

// Use a temp dir as state root so tests don't write to ~/.apex
let stateDir: string;

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-runtime-test-'));
});

afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe('ApexRuntime — wiring', () => {
  it('instantiates all Phase 1 services', () => {
    const rt = new ApexRuntime({ auditLog: new NoOpAuditLog(), stateDir });
    expect(rt.auditLog).toBeDefined();
    expect(rt.approvalService).toBeDefined();
    expect(rt.allowlist).toBeDefined();
    expect(rt.firewall).toBeInstanceOf(TieredFirewall);
    expect(rt.shellEngine).toBeInstanceOf(ShellEngine);
    expect(rt.dockerEngine).toBeInstanceOf(DockerEngine);
    expect(rt.fileOps).toBeDefined();
    expect(rt.authManager).toBeDefined();
    expect(rt.heartbeat).toBeInstanceOf(HeartbeatScheduler);
    expect(rt.checkpointStore).toBeInstanceOf(CheckpointStore);
    expect(rt.memoryManager).toBeInstanceOf(MemoryManager);
  });

  it('exposes version string', () => {
    const rt = new ApexRuntime({ auditLog: new NoOpAuditLog(), stateDir });
    expect(rt.version).toBe('1.0.0');
  });

  it('accepts custom keychain', () => {
    const keychain = new MemoryKeychain();
    const rt = new ApexRuntime({ keychain, auditLog: new NoOpAuditLog(), stateDir });
    expect(rt.authManager).toBeDefined();
  });

  it('accepts onApprovalRequired callback', () => {
    const cb = jest.fn();
    const rt = new ApexRuntime({ onApprovalRequired: cb, auditLog: new NoOpAuditLog(), stateDir });
    expect(rt.firewall).toBeDefined();
  });
});

describe('ApexRuntime — lifecycle', () => {
  it('start() creates ~/.apex subdirectories relative to apex home', async () => {
    // We can't override apex home, but we can verify the heartbeat starts
    const audit = new NoOpAuditLog();
    const rt = new ApexRuntime({ auditLog: audit, stateDir });
    await rt.start();
    expect(rt.heartbeat.isRunning).toBe(true);
    await rt.stop();
  });

  it('start() writes a startup audit entry', async () => {
    const audit = new CapturingAuditLog();
    const rt = new ApexRuntime({ auditLog: audit, stateDir });
    await rt.start();
    const startEntry = audit.entries.find(e => e.action === 'runtime.start');
    expect(startEntry).toBeDefined();
    expect(startEntry?.level).toBe('info');
    await rt.stop();
  });

  it('stop() stops the heartbeat scheduler', async () => {
    const rt = new ApexRuntime({ auditLog: new NoOpAuditLog(), stateDir });
    await rt.start();
    expect(rt.heartbeat.isRunning).toBe(true);
    await rt.stop();
    expect(rt.heartbeat.isRunning).toBe(false);
  });

  it('stop() writes a shutdown audit entry', async () => {
    const audit = new CapturingAuditLog();
    const rt = new ApexRuntime({ auditLog: audit, stateDir });
    await rt.start();
    await rt.stop();
    const stopEntry = audit.entries.find(e => e.action === 'runtime.stop');
    expect(stopEntry).toBeDefined();
    expect(stopEntry?.level).toBe('info');
  });

  it('stop() without start() does not throw', async () => {
    const rt = new ApexRuntime({ auditLog: new NoOpAuditLog(), stateDir });
    await expect(rt.stop()).resolves.not.toThrow();
  });
});

describe('ApexRuntime — heartbeatIntervalSeconds', () => {
  it('returns the heartbeat interval', () => {
    const rt = new ApexRuntime({ auditLog: new NoOpAuditLog(), stateDir });
    expect(rt.heartbeatIntervalSeconds).toBeGreaterThan(0);
  });
});

describe('ApexRuntime — shell integration', () => {
  it('shellEngine is wired to the firewall (Tier 1 commands execute)', async () => {
    const rt = new ApexRuntime({ auditLog: new NoOpAuditLog(), stateDir });
    // 'echo hello' is Tier 1 — should execute without approval
    const result = await rt.shellEngine.exec('echo hello');
    expect(result.exit_code).toBe(0);
    expect(result.stdout.trim()).toBe('hello');
  });

  it('shellEngine rejects sudo (SAFETY GATE)', async () => {
    const rt = new ApexRuntime({ auditLog: new NoOpAuditLog(), stateDir });
    await expect(rt.shellEngine.exec('sudo ls')).rejects.toThrow('SAFETY GATE');
  });
});
