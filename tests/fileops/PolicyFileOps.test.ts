// Co-authored by FORGE (Session: forge-20260324215726-1658598)
// tests/fileops/PolicyFileOps.test.ts — JAL-004 Policy-bounded file operations tests

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

import { PolicyFileOps, SHELL_PROFILE_NAMES, SYSTEM_PATH_PREFIXES } from '../../src/apex/fileops/PolicyFileOps';
import { WorkspaceRootsConfig } from '../../src/apex/fileops/WorkspaceRootsConfig';
import { ApprovalService } from '../../src/apex/policy/ApprovalService';
import { CapturingAuditLog, NoOpAuditLog } from '../../src/apex/policy/AuditLog';
import { ApprovalToken } from '../../src/apex/types';

// ── Helpers ──────────────────────────────────────────────────────────────────

interface Rig {
  workspaceDir: string;
  outsideDir: string;
  rootsPath: string;
  roots: WorkspaceRootsConfig;
  approval: ApprovalService;
  audit: CapturingAuditLog;
  ops: PolicyFileOps;
}

function makeRig(onApprovalRequired?: (token: ApprovalToken) => void): Rig {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-ws-'));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-out-'));
  const rootsPath = path.join(workspaceDir, 'workspace-roots.json');

  const audit = new CapturingAuditLog();
  const roots = new WorkspaceRootsConfig(new NoOpAuditLog(), rootsPath);
  roots.add(workspaceDir);

  const approval = new ApprovalService();
  const ops = new PolicyFileOps(roots, approval, audit, onApprovalRequired);

  return { workspaceDir, outsideDir, rootsPath, roots, approval, audit, ops };
}

function cleanRig(rig: Rig): void {
  fs.rmSync(rig.workspaceDir, { recursive: true, force: true });
  fs.rmSync(rig.outsideDir, { recursive: true, force: true });
}

// ── WorkspaceRootsConfig ──────────────────────────────────────────────────────

describe('WorkspaceRootsConfig', () => {
  let tmpDir: string;
  let rootsPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-roots-'));
    rootsPath = path.join(tmpDir, 'workspace-roots.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates the JSON file on first load if it does not exist', () => {
    const wrc = new WorkspaceRootsConfig(new NoOpAuditLog(), rootsPath);
    wrc.list(); // triggers load
    expect(fs.existsSync(rootsPath)).toBe(true);
  });

  it('starts with empty roots when no file and no env var', () => {
    const saved = process.env['APEX_WORKSPACE_ROOTS'];
    delete process.env['APEX_WORKSPACE_ROOTS'];

    const wrc = new WorkspaceRootsConfig(new NoOpAuditLog(), rootsPath);
    expect(wrc.list().roots).toHaveLength(0);

    if (saved !== undefined) process.env['APEX_WORKSPACE_ROOTS'] = saved;
  });

  it('add() makes isInsideWorkspace return true for child paths', () => {
    const wrc = new WorkspaceRootsConfig(new NoOpAuditLog(), rootsPath);
    wrc.add(tmpDir);
    expect(wrc.isInsideWorkspace(path.join(tmpDir, 'foo', 'bar.ts'))).toBe(true);
  });

  it('isInsideWorkspace returns true for the root itself', () => {
    const wrc = new WorkspaceRootsConfig(new NoOpAuditLog(), rootsPath);
    wrc.add(tmpDir);
    expect(wrc.isInsideWorkspace(tmpDir)).toBe(true);
  });

  it('isInsideWorkspace returns false for paths outside any root', () => {
    const wrc = new WorkspaceRootsConfig(new NoOpAuditLog(), rootsPath);
    wrc.add(tmpDir);
    expect(wrc.isInsideWorkspace('/some/completely/other/path')).toBe(false);
  });

  it('add() is idempotent', () => {
    const audit = new CapturingAuditLog();
    const wrc = new WorkspaceRootsConfig(audit, rootsPath);
    wrc.add(tmpDir);
    wrc.add(tmpDir);
    expect(wrc.list().roots).toHaveLength(1);
    expect(audit.entries).toHaveLength(1); // only one audit entry
  });

  it('add() increments version', () => {
    const wrc = new WorkspaceRootsConfig(new NoOpAuditLog(), rootsPath);
    const v0 = wrc.list().version;
    wrc.add(tmpDir);
    expect(wrc.list().version).toBe(v0 + 1);
  });

  it('remove() makes isInsideWorkspace return false', () => {
    const wrc = new WorkspaceRootsConfig(new NoOpAuditLog(), rootsPath);
    wrc.add(tmpDir);
    wrc.remove(tmpDir);
    expect(wrc.isInsideWorkspace(path.join(tmpDir, 'file.ts'))).toBe(false);
  });

  it('remove() is idempotent (removing absent root is a no-op)', () => {
    const audit = new CapturingAuditLog();
    const wrc = new WorkspaceRootsConfig(audit, rootsPath);
    wrc.remove('/nonexistent/path');
    expect(audit.entries).toHaveLength(0);
  });

  it('remove() increments version', () => {
    const wrc = new WorkspaceRootsConfig(new NoOpAuditLog(), rootsPath);
    wrc.add(tmpDir);
    const v1 = wrc.list().version;
    wrc.remove(tmpDir);
    expect(wrc.list().version).toBe(v1 + 1);
  });

  it('add() audit-logs the change with workspace_roots.add action', () => {
    const audit = new CapturingAuditLog();
    const wrc = new WorkspaceRootsConfig(audit, rootsPath);
    wrc.add(tmpDir);
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0].action).toBe('workspace_roots.add');
  });

  it('remove() audit-logs the change with workspace_roots.remove action', () => {
    const audit = new CapturingAuditLog();
    const wrc = new WorkspaceRootsConfig(audit, rootsPath);
    wrc.add('/some/path');
    audit.entries.length = 0; // reset
    wrc.remove('/some/path');
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0].action).toBe('workspace_roots.remove');
  });

  it('persists to disk and survives re-instantiation', () => {
    const wrc1 = new WorkspaceRootsConfig(new NoOpAuditLog(), rootsPath);
    wrc1.add(tmpDir);

    const wrc2 = new WorkspaceRootsConfig(new NoOpAuditLog(), rootsPath);
    expect(wrc2.list().roots).toContain(path.resolve(tmpDir));
  });

  it('loads from APEX_WORKSPACE_ROOTS env var when file does not exist', () => {
    const saved = process.env['APEX_WORKSPACE_ROOTS'];
    process.env['APEX_WORKSPACE_ROOTS'] = tmpDir;

    const altPath = path.join(tmpDir, 'alt-roots.json');
    const wrc = new WorkspaceRootsConfig(new NoOpAuditLog(), altPath);
    const file = wrc.list();

    expect(file.roots).toContain(path.resolve(tmpDir));

    if (saved !== undefined) process.env['APEX_WORKSPACE_ROOTS'] = saved;
    else delete process.env['APEX_WORKSPACE_ROOTS'];
  });
});

// ── PolicyFileOps — safety constants ─────────────────────────────────────────

describe('PolicyFileOps constants', () => {
  it('SHELL_PROFILE_NAMES includes common shell profiles', () => {
    expect(SHELL_PROFILE_NAMES.has('.bashrc')).toBe(true);
    expect(SHELL_PROFILE_NAMES.has('.zshrc')).toBe(true);
    expect(SHELL_PROFILE_NAMES.has('.profile')).toBe(true);
    expect(SHELL_PROFILE_NAMES.has('.bash_profile')).toBe(true);
    expect(SHELL_PROFILE_NAMES.has('config.fish')).toBe(true);
  });

  it('SYSTEM_PATH_PREFIXES includes /etc/ and /usr/', () => {
    expect(SYSTEM_PATH_PREFIXES).toContain('/etc/');
    expect(SYSTEM_PATH_PREFIXES).toContain('/usr/');
    expect(SYSTEM_PATH_PREFIXES).toContain('/bin/');
    expect(SYSTEM_PATH_PREFIXES).toContain('/sys/');
  });
});

// ── PolicyFileOps — path traversal rejection ─────────────────────────────────

describe('PolicyFileOps — path traversal safety gate', () => {
  it('rejects paths containing ../ in read', async () => {
    const rig = makeRig();
    const result = await rig.ops.read('../etc/passwd');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/path traversal/i);
    cleanRig(rig);
  });

  it('rejects paths containing ../ in write', async () => {
    const rig = makeRig();
    const result = await rig.ops.write('/tmp/../etc/shadow', 'bad');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/path traversal/i);
    cleanRig(rig);
  });

  it('rejects paths containing ../ in create', async () => {
    const rig = makeRig();
    const result = await rig.ops.create('../../outside', 'bad');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/path traversal/i);
    cleanRig(rig);
  });

  it('rejects paths containing ../ in delete', async () => {
    const rig = makeRig();
    const result = await rig.ops.delete('../victim');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/path traversal/i);
    cleanRig(rig);
  });

  it('rejects paths containing ../ in chmod', async () => {
    const rig = makeRig();
    const result = await rig.ops.chmod('../victim', '755');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/path traversal/i);
    cleanRig(rig);
  });

  it('rejects paths containing ../ in chown', async () => {
    const rig = makeRig();
    const result = await rig.ops.chown('../victim', 0, 0);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/path traversal/i);
    cleanRig(rig);
  });

  it('audit-logs every path traversal rejection', async () => {
    const rig = makeRig();
    await rig.ops.read('../etc/passwd');
    const rejections = rig.audit.entries.filter(e => e.level === 'error');
    expect(rejections.length).toBeGreaterThanOrEqual(1);
    cleanRig(rig);
  });
});

// ── PolicyFileOps — read (Tier 1) ─────────────────────────────────────────────

describe('PolicyFileOps — read (always Tier 1)', () => {
  it('read inside workspace is Tier 1 auto-approved', async () => {
    const rig = makeRig();
    const filePath = path.join(rig.workspaceDir, 'hello.txt');
    fs.writeFileSync(filePath, 'hello');

    const result = await rig.ops.read(filePath);
    expect(result.success).toBe(true);
    expect(result.tier_decision.tier).toBe(1);
    expect(result.tier_decision.approved).toBe(true);
    expect(result.content).toBe('hello');
    cleanRig(rig);
  });

  it('read outside workspace is still Tier 1 (reads are non-destructive)', async () => {
    const rig = makeRig();
    const filePath = path.join(rig.outsideDir, 'outside.txt');
    fs.writeFileSync(filePath, 'outside content');

    const result = await rig.ops.read(filePath);
    expect(result.tier_decision.tier).toBe(1);
    expect(result.tier_decision.approved).toBe(true);
    cleanRig(rig);
  });

  it('read emits a TierDecision with action, tier, and reason', async () => {
    const rig = makeRig();
    const filePath = path.join(rig.workspaceDir, 'a.txt');
    fs.writeFileSync(filePath, 'x');

    const result = await rig.ops.read(filePath);
    expect(result.tier_decision.action).toBeDefined();
    expect(result.tier_decision.tier).toBeDefined();
    expect(result.tier_decision.reason).toBeDefined();
    cleanRig(rig);
  });

  it('read writes an audit entry', async () => {
    const rig = makeRig();
    const filePath = path.join(rig.workspaceDir, 'b.txt');
    fs.writeFileSync(filePath, 'y');

    await rig.ops.read(filePath);
    expect(rig.audit.entries.length).toBeGreaterThanOrEqual(1);
    cleanRig(rig);
  });
});

// ── PolicyFileOps — write / create (Tier 1 inside workspace) ──────────────────

describe('PolicyFileOps — write/create inside workspace (Tier 1)', () => {
  it('write inside workspace is Tier 1 auto-approved', async () => {
    const rig = makeRig();
    const filePath = path.join(rig.workspaceDir, 'output.txt');

    const result = await rig.ops.write(filePath, 'data');
    expect(result.success).toBe(true);
    expect(result.tier_decision.tier).toBe(1);
    expect(result.tier_decision.approved).toBe(true);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('data');
    cleanRig(rig);
  });

  it('create inside workspace is Tier 1 auto-approved', async () => {
    const rig = makeRig();
    const filePath = path.join(rig.workspaceDir, 'new.txt');

    const result = await rig.ops.create(filePath, 'created');
    expect(result.success).toBe(true);
    expect(result.tier_decision.tier).toBe(1);
    expect(result.tier_decision.approved).toBe(true);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('created');
    cleanRig(rig);
  });

  it('write creates intermediate directories inside workspace', async () => {
    const rig = makeRig();
    const filePath = path.join(rig.workspaceDir, 'deep', 'nested', 'file.ts');

    const result = await rig.ops.write(filePath, 'ts content');
    expect(result.success).toBe(true);
    expect(fs.existsSync(filePath)).toBe(true);
    cleanRig(rig);
  });

  it('Tier 1 write emits an audit entry with action and tier', async () => {
    const rig = makeRig();
    const filePath = path.join(rig.workspaceDir, 'log.txt');

    await rig.ops.write(filePath, 'logged');
    const entry = rig.audit.entries.find(e => e.action === 'file.write');
    expect(entry).toBeDefined();
    expect(entry?.tier).toBe(1);
    cleanRig(rig);
  });
});

// ── PolicyFileOps — Tier 2: writes outside workspace ─────────────────────────

describe('PolicyFileOps — write outside workspace (Tier 2)', () => {
  it('write outside workspace requires Tier 2 and is denied when operator denies', async () => {
    const rig = makeRig((token) => {
      rig.approval.resolve(token.id, false);
    });
    const filePath = path.join(rig.outsideDir, 'output.txt');

    const result = await rig.ops.write(filePath, 'data');
    expect(result.success).toBe(false);
    expect(result.tier_decision.tier).toBe(2);
    expect(result.tier_decision.approved).toBe(false);
    expect(fs.existsSync(filePath)).toBe(false);
    cleanRig(rig);
  });

  it('write outside workspace succeeds when operator approves', async () => {
    const rig = makeRig((token) => {
      rig.approval.resolve(token.id, true);
    });
    const filePath = path.join(rig.outsideDir, 'approved.txt');

    const result = await rig.ops.write(filePath, 'approved content');
    expect(result.success).toBe(true);
    expect(result.tier_decision.tier).toBe(2);
    expect(result.tier_decision.approved).toBe(true);
    cleanRig(rig);
  });

  it('onApprovalRequired callback is fired for writes outside workspace', async () => {
    const onApproval = jest.fn((token: ApprovalToken) => {
      rig.approval.resolve(token.id, false);
    });
    const rig = makeRig(onApproval);
    const filePath = path.join(rig.outsideDir, 'cb.txt');

    await rig.ops.write(filePath, 'x');
    expect(onApproval).toHaveBeenCalledTimes(1);
    cleanRig(rig);
  });
});

// ── PolicyFileOps — Tier 2: shell profile writes ──────────────────────────────

describe('PolicyFileOps — shell profile writes (Tier 2)', () => {
  const shellProfiles = ['.bashrc', '.zshrc', '.profile', '.bash_profile', '.zshenv', 'config.fish'];

  it.each(shellProfiles)('write to %s requires Tier 2', async (profileName) => {
    const onApproval = jest.fn((token: ApprovalToken) => {
      approval.resolve(token.id, false);
    });
    const audit = new CapturingAuditLog();
    const approval = new ApprovalService();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-shell-'));
    const rootsPath = path.join(tmpDir, 'roots.json');
    const roots = new WorkspaceRootsConfig(new NoOpAuditLog(), rootsPath);
    // Make home-like dir a workspace root so we can test shell profile detection
    roots.add(tmpDir);
    const ops = new PolicyFileOps(roots, approval, audit, onApproval);

    // Write shell profile inside the workspace — still Tier 2 due to profile name
    const profilePath = path.join(tmpDir, profileName);
    const result = await ops.write(profilePath, '# config');

    expect(result.tier_decision.tier).toBe(2);
    expect(onApproval).toHaveBeenCalledTimes(1);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ── PolicyFileOps — Tier 2: system path writes ────────────────────────────────

describe('PolicyFileOps — system path writes (Tier 2)', () => {
  const systemPaths = ['/etc/hosts', '/usr/local/bin/mytool', '/bin/fake-binary'];

  it.each(systemPaths)('classify write to %s returns Tier 2', async (sysPath) => {
    const rig = makeRig((token) => {
      rig.approval.resolve(token.id, false);
    });
    const decision = await rig.ops.classify('write', sysPath);
    expect(decision.tier).toBe(2);
    cleanRig(rig);
  });
});

// ── PolicyFileOps — delete (always Tier 2) ───────────────────────────────────

describe('PolicyFileOps — delete (always Tier 2)', () => {
  it('non-recursive delete requires Tier 2 approval', async () => {
    const rig = makeRig((token) => {
      rig.approval.resolve(token.id, false);
    });
    const filePath = path.join(rig.workspaceDir, 'to-delete.txt');
    fs.writeFileSync(filePath, 'bye');

    const result = await rig.ops.delete(filePath);
    expect(result.tier_decision.tier).toBe(2);
    expect(result.success).toBe(false);
    expect(fs.existsSync(filePath)).toBe(true); // not deleted
    cleanRig(rig);
  });

  it('recursive delete requires Tier 2 approval', async () => {
    const rig = makeRig((token) => {
      rig.approval.resolve(token.id, false);
    });
    const dirPath = path.join(rig.workspaceDir, 'subdir');
    fs.mkdirSync(dirPath);

    const result = await rig.ops.delete(dirPath, { recursive: true });
    expect(result.tier_decision.tier).toBe(2);
    expect(result.success).toBe(false);
    expect(fs.existsSync(dirPath)).toBe(true);
    cleanRig(rig);
  });

  it('recursive delete proceeds when operator approves', async () => {
    const rig = makeRig((token) => {
      rig.approval.resolve(token.id, true);
    });
    const dirPath = path.join(rig.workspaceDir, 'delete-me');
    fs.mkdirSync(dirPath);
    fs.writeFileSync(path.join(dirPath, 'file.txt'), 'content');

    const result = await rig.ops.delete(dirPath, { recursive: true });
    expect(result.success).toBe(true);
    expect(fs.existsSync(dirPath)).toBe(false);
    cleanRig(rig);
  });

  it('recursive delete action string is file.delete.recursive', async () => {
    const rig = makeRig((token) => {
      rig.approval.resolve(token.id, false);
    });
    const dirPath = path.join(rig.workspaceDir, 'rdir');
    fs.mkdirSync(dirPath);

    const result = await rig.ops.delete(dirPath, { recursive: true });
    expect(result.tier_decision.action).toBe('file.delete.recursive');
    cleanRig(rig);
  });
});

// ── PolicyFileOps — chmod / chown (always Tier 2) ─────────────────────────────

describe('PolicyFileOps — chmod/chown (always Tier 2)', () => {
  it('chmod requires Tier 2 and is denied when operator denies', async () => {
    const rig = makeRig((token) => {
      rig.approval.resolve(token.id, false);
    });
    const filePath = path.join(rig.workspaceDir, 'script.sh');
    fs.writeFileSync(filePath, '#!/bin/bash');

    const result = await rig.ops.chmod(filePath, '755');
    expect(result.tier_decision.tier).toBe(2);
    expect(result.success).toBe(false);
    cleanRig(rig);
  });

  it('chmod succeeds when operator approves', async () => {
    const rig = makeRig((token) => {
      rig.approval.resolve(token.id, true);
    });
    const filePath = path.join(rig.workspaceDir, 'script.sh');
    fs.writeFileSync(filePath, '#!/bin/bash');

    const result = await rig.ops.chmod(filePath, 0o755);
    expect(result.success).toBe(true);
    expect(result.tier_decision.tier).toBe(2);
    cleanRig(rig);
  });

  it('chown requires Tier 2 and is denied when operator denies', async () => {
    const rig = makeRig((token) => {
      rig.approval.resolve(token.id, false);
    });
    const filePath = path.join(rig.workspaceDir, 'owned.txt');
    fs.writeFileSync(filePath, 'x');

    const result = await rig.ops.chown(filePath, process.getuid!(), process.getgid!());
    expect(result.tier_decision.tier).toBe(2);
    cleanRig(rig);
  });
});

// ── PolicyFileOps — classify() pre-flight method ─────────────────────────────

describe('PolicyFileOps — classify() pre-flight', () => {
  it('classify read returns Tier 1', async () => {
    const rig = makeRig();
    const filePath = path.join(rig.workspaceDir, 'x.txt');
    const decision = await rig.ops.classify('read', filePath);
    expect(decision.tier).toBe(1);
    expect(decision.approved).toBe(true);
    cleanRig(rig);
  });

  it('classify write inside workspace returns Tier 1', async () => {
    const rig = makeRig();
    const filePath = path.join(rig.workspaceDir, 'x.txt');
    const decision = await rig.ops.classify('write', filePath);
    expect(decision.tier).toBe(1);
    expect(decision.approved).toBe(true);
    cleanRig(rig);
  });

  it('classify write outside workspace returns Tier 2', async () => {
    const rig = makeRig((token) => {
      rig.approval.resolve(token.id, false);
    });
    const filePath = path.join(rig.outsideDir, 'x.txt');
    const decision = await rig.ops.classify('write', filePath);
    expect(decision.tier).toBe(2);
    cleanRig(rig);
  });

  it('classify delete returns Tier 2', async () => {
    const rig = makeRig((token) => {
      rig.approval.resolve(token.id, false);
    });
    const filePath = path.join(rig.workspaceDir, 'x.txt');
    const decision = await rig.ops.classify('delete', filePath);
    expect(decision.tier).toBe(2);
    cleanRig(rig);
  });

  it('classify recursive delete returns Tier 2 with recursive action string', async () => {
    const rig = makeRig((token) => {
      rig.approval.resolve(token.id, false);
    });
    const dirPath = path.join(rig.workspaceDir, 'dir');
    const decision = await rig.ops.classify('delete', dirPath, { recursive: true });
    expect(decision.tier).toBe(2);
    expect(decision.action).toBe('file.delete.recursive');
    cleanRig(rig);
  });

  it('classify chmod returns Tier 2', async () => {
    const rig = makeRig((token) => {
      rig.approval.resolve(token.id, false);
    });
    const filePath = path.join(rig.workspaceDir, 'x.txt');
    const decision = await rig.ops.classify('chmod', filePath);
    expect(decision.tier).toBe(2);
    cleanRig(rig);
  });

  it('classify chown returns Tier 2', async () => {
    const rig = makeRig((token) => {
      rig.approval.resolve(token.id, false);
    });
    const filePath = path.join(rig.workspaceDir, 'x.txt');
    const decision = await rig.ops.classify('chown', filePath);
    expect(decision.tier).toBe(2);
    cleanRig(rig);
  });

  it('classify with path traversal returns rejected TierDecision', async () => {
    const rig = makeRig();
    const decision = await rig.ops.classify('write', '../outside');
    expect(decision.approved).toBe(false);
    expect(decision.reason).toMatch(/path traversal/i);
    cleanRig(rig);
  });
});

// ── PolicyFileOps — TierDecision structure ───────────────────────────────────

describe('PolicyFileOps — TierDecision fields', () => {
  it('every TierDecision has action, tier, reason, approved, decided_at', async () => {
    const rig = makeRig();
    const filePath = path.join(rig.workspaceDir, 'check.txt');
    fs.writeFileSync(filePath, 'x');

    const result = await rig.ops.read(filePath);
    const d = result.tier_decision;
    expect(d.action).toBeDefined();
    expect(d.tier).toBeDefined();
    expect(d.reason).toBeDefined();
    expect(typeof d.approved).toBe('boolean');
    expect(d.decided_at).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO timestamp
    cleanRig(rig);
  });

  it('Tier 2 TierDecision includes approval_id', async () => {
    const rig = makeRig((token) => {
      rig.approval.resolve(token.id, true);
    });
    const filePath = path.join(rig.outsideDir, 'x.txt');

    const result = await rig.ops.write(filePath, 'x');
    expect(result.tier_decision.approval_id).toBeDefined();
    cleanRig(rig);
  });
});

// ── PolicyFileOps — audit log on every rejection ──────────────────────────────

describe('PolicyFileOps — audit log on every rejection', () => {
  it('denied write emits at least two audit entries (pending + denial)', async () => {
    const rig = makeRig((token) => {
      rig.approval.resolve(token.id, false);
    });
    const filePath = path.join(rig.outsideDir, 'denied.txt');

    await rig.ops.write(filePath, 'nope');
    expect(rig.audit.entries.length).toBeGreaterThanOrEqual(2);
    cleanRig(rig);
  });

  it('path traversal rejection emits an error-level audit entry', async () => {
    const rig = makeRig();

    await rig.ops.write('../hack', 'bad');
    const errorEntry = rig.audit.entries.find(e => e.level === 'error');
    expect(errorEntry).toBeDefined();
    cleanRig(rig);
  });

  it('approved Tier 2 write emits a final info-level audit entry', async () => {
    const rig = makeRig((token) => {
      rig.approval.resolve(token.id, true);
    });
    const filePath = path.join(rig.outsideDir, 'ok.txt');

    await rig.ops.write(filePath, 'good');
    const infoEntry = rig.audit.entries.find(e => e.level === 'info' && e.action === 'file.write');
    expect(infoEntry).toBeDefined();
    cleanRig(rig);
  });
});
