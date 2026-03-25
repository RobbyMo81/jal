// Co-authored by FORGE (Session: forge-20260324215726-1658598)
// tests/policy/TieredFirewall.test.ts — JAL-003 comprehensive policy layer tests

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

import { TieredFirewall } from '../../src/apex/policy/TieredFirewall';
import { ApprovalService } from '../../src/apex/policy/ApprovalService';
import { PackageAllowlist } from '../../src/apex/policy/PackageAllowlist';
import { AuditLog, CapturingAuditLog, NoOpAuditLog } from '../../src/apex/policy/AuditLog';
import { ApprovalToken } from '../../src/apex/types';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeFirewall(
  onApprovalRequired?: (token: ApprovalToken) => void,
  allowlistPath?: string
): { fw: TieredFirewall; approval: ApprovalService; audit: CapturingAuditLog } {
  const approval = new ApprovalService();
  const audit = new CapturingAuditLog();
  const allowlist = new PackageAllowlist(new NoOpAuditLog(), allowlistPath);
  const fw = new TieredFirewall(approval, audit, allowlist, onApprovalRequired);
  return { fw, approval, audit };
}

// ── AuditLog ─────────────────────────────────────────────────────────────────

describe('AuditLog', () => {
  let tmpDir: string;
  let logPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-audit-'));
    logPath = path.join(tmpDir, 'audit.log');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes entries as JSONL to the log file', () => {
    const log = new AuditLog(logPath);
    log.write({ timestamp: '2026-01-01T00:00:00.000Z', level: 'info', service: 'test', message: 'hello' });

    const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.message).toBe('hello');
    expect(parsed.curr_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(parsed.prev_hash).toBe('');
  });

  it('chains hashes across multiple entries', () => {
    const log = new AuditLog(logPath);
    log.write({ timestamp: '2026-01-01T00:00:00.000Z', level: 'info', service: 'svc', message: 'first' });
    log.write({ timestamp: '2026-01-01T00:00:01.000Z', level: 'info', service: 'svc', message: 'second' });

    const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    const first = JSON.parse(lines[0]);
    const second = JSON.parse(lines[1]);

    expect(second.prev_hash).toBe(first.curr_hash);
    expect(second.curr_hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('creates directory if it does not exist', () => {
    const nested = path.join(tmpDir, 'a', 'b', 'audit.log');
    const log = new AuditLog(nested);
    log.write({ timestamp: '2026-01-01T00:00:00.000Z', level: 'warn', service: 'svc', message: 'ok' });
    expect(fs.existsSync(nested)).toBe(true);
  });

  describe('CapturingAuditLog', () => {
    it('captures entries in memory for assertions', () => {
      const log = new CapturingAuditLog();
      log.write({ timestamp: 't', level: 'info', service: 'x', message: 'captured' });
      expect(log.entries).toHaveLength(1);
      expect(log.entries[0].message).toBe('captured');
    });
  });

  describe('NoOpAuditLog', () => {
    it('does not throw', () => {
      const log = new NoOpAuditLog();
      expect(() => log.write({ timestamp: 't', level: 'info', service: 'x', message: 'm' })).not.toThrow();
    });
  });
});

// ── ApprovalService ───────────────────────────────────────────────────────────

describe('ApprovalService', () => {
  beforeEach(() => jest.clearAllMocks());
  afterEach(() => jest.useRealTimers());

  it('creates a pending token and resolves when approved', async () => {
    const svc = new ApprovalService();
    const { token, promise } = svc.requestApproval('shell.exec', { command: 'ls' }, 2, 'test');

    expect(token.status).toBe('pending');
    expect(svc.isPending(token.id)).toBe(true);

    const approved = svc.resolve(token.id, true);
    expect(approved).toBe(true);

    const result = await promise;
    expect(result).toBe(true);
    expect(svc.isPending(token.id)).toBe(false);
  });

  it('resolves false when denied', async () => {
    const svc = new ApprovalService();
    const { token, promise } = svc.requestApproval('shell.exec', { command: 'rm file' }, 2, 'test');

    svc.resolve(token.id, false);
    const result = await promise;
    expect(result).toBe(false);
  });

  it('returns false for resolve on unknown token', () => {
    const svc = new ApprovalService();
    expect(svc.resolve('not-a-real-id', true)).toBe(false);
  });

  it('second resolve on same token is a no-op (single-use)', async () => {
    const svc = new ApprovalService();
    const { token, promise } = svc.requestApproval('shell.exec', { command: 'ls' }, 2, 'r');

    svc.resolve(token.id, true);
    await promise;

    // Token is gone — second resolve returns false, no error
    expect(svc.resolve(token.id, false)).toBe(false);
  });

  it('expires tokens after TOKEN_TTL_MS', async () => {
    jest.useFakeTimers();
    const svc = new ApprovalService();
    const { promise } = svc.requestApproval('shell.exec', { command: 'ls' }, 2, 'ttl test');

    // Advance time past the 5-minute TTL
    jest.advanceTimersByTime(5 * 60 * 1_000 + 1);

    const result = await promise;
    expect(result).toBe(false);
  });

  it('computes consistent context_hash for the same inputs', () => {
    const svc = new ApprovalService();
    const ctx = { command: 'ls', cwd: '/tmp' };
    const { token: t1 } = svc.requestApproval('shell.exec', ctx, 2, 'r1');
    svc.resolve(t1.id, true);

    const { token: t2 } = svc.requestApproval('shell.exec', ctx, 2, 'r2');
    svc.resolve(t2.id, true);

    expect(t1.context_hash).toBe(t2.context_hash);
  });

  it('getPendingTokens returns only unresolved tokens', async () => {
    const svc = new ApprovalService();
    const { token: t1, promise: p1 } = svc.requestApproval('shell.exec', {}, 2, 'a');
    const { token: t2 } = svc.requestApproval('docker.rm', {}, 2, 'b');

    expect(svc.getPendingTokens()).toHaveLength(2);

    svc.resolve(t1.id, true);
    await p1;

    const pending = svc.getPendingTokens();
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(t2.id);

    // Cleanup
    svc.resolve(t2.id, false);
  });
});

// ── PackageAllowlist ──────────────────────────────────────────────────────────

describe('PackageAllowlist', () => {
  let tmpDir: string;
  let allowlistPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-allowlist-'));
    allowlistPath = path.join(tmpDir, 'package-allowlist.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates an empty allowlist file on first load', () => {
    const audit = new CapturingAuditLog();
    const al = new PackageAllowlist(audit, allowlistPath);
    expect(al.isAllowed('lodash', 'npm')).toBe(false);
    expect(fs.existsSync(allowlistPath)).toBe(true);
  });

  it('add() makes a package allowed', () => {
    const audit = new CapturingAuditLog();
    const al = new PackageAllowlist(audit, allowlistPath);
    al.add('lodash', 'npm');
    expect(al.isAllowed('lodash', 'npm')).toBe(true);
  });

  it('add() is idempotent', () => {
    const audit = new CapturingAuditLog();
    const al = new PackageAllowlist(audit, allowlistPath);
    al.add('lodash', 'npm');
    al.add('lodash', 'npm'); // second add is a no-op
    expect(al.list().entries).toHaveLength(1);
    expect(audit.entries).toHaveLength(1); // only one audit entry
  });

  it('remove() makes a package disallowed', () => {
    const audit = new CapturingAuditLog();
    const al = new PackageAllowlist(audit, allowlistPath);
    al.add('lodash', 'npm');
    al.remove('lodash', 'npm');
    expect(al.isAllowed('lodash', 'npm')).toBe(false);
  });

  it('remove() is idempotent (removing absent package is no-op)', () => {
    const audit = new CapturingAuditLog();
    const al = new PackageAllowlist(audit, allowlistPath);
    al.remove('nonexistent', 'npm'); // should not throw or audit
    expect(audit.entries).toHaveLength(0);
  });

  it('increments version on add', () => {
    const audit = new CapturingAuditLog();
    const al = new PackageAllowlist(audit, allowlistPath);
    const v0 = al.list().version;
    al.add('express', 'npm');
    expect(al.list().version).toBe(v0 + 1);
  });

  it('increments version on remove', () => {
    const audit = new CapturingAuditLog();
    const al = new PackageAllowlist(audit, allowlistPath);
    al.add('express', 'npm');
    const v1 = al.list().version;
    al.remove('express', 'npm');
    expect(al.list().version).toBe(v1 + 1);
  });

  it('audit-logs every add and remove', () => {
    const audit = new CapturingAuditLog();
    const al = new PackageAllowlist(audit, allowlistPath);
    al.add('requests', 'pip');
    al.remove('requests', 'pip');
    expect(audit.entries).toHaveLength(2);
    expect(audit.entries[0].action).toBe('allowlist.add');
    expect(audit.entries[1].action).toBe('allowlist.remove');
  });

  it('persists to disk and survives re-instantiation', () => {
    const al1 = new PackageAllowlist(new NoOpAuditLog(), allowlistPath);
    al1.add('lodash', 'npm');

    const al2 = new PackageAllowlist(new NoOpAuditLog(), allowlistPath);
    expect(al2.isAllowed('lodash', 'npm')).toBe(true);
  });

  it('manager is scoped — npm/lodash differs from pip/lodash', () => {
    const al = new PackageAllowlist(new NoOpAuditLog(), allowlistPath);
    al.add('lodash', 'npm');
    expect(al.isAllowed('lodash', 'pip')).toBe(false);
  });
});

// ── TieredFirewall ────────────────────────────────────────────────────────────

describe('TieredFirewall', () => {
  // ── Tier 1 shell commands ───────────────────────────────────────────────

  describe('shell.exec — Tier 1 (auto-approved)', () => {
    const tier1Commands = [
      'ls -la',
      'cat file.txt',
      'echo hello',
      'pwd',
      'which node',
      'env',
      'date',
      'df -h',
      'ps aux',
      'git status',
    ];

    it.each(tier1Commands)('auto-approves: %s', async (command) => {
      const { fw, audit } = makeFirewall();
      const decision = await fw.classify('shell.exec', { command });
      expect(decision.tier).toBe(1);
      expect(decision.approved).toBe(true);
      expect(audit.entries.length).toBeGreaterThan(0);
    });
  });

  // ── Tier 2 shell commands ───────────────────────────────────────────────

  describe('shell.exec — Tier 2 (HITL required)', () => {
    const tier2Commands = [
      ['rm -rf /tmp/junk', 'rm'],
      ['rmdir mydir', 'rmdir'],
      ['chmod 755 script.sh', 'chmod'],
      ['chown user:group file', 'chown'],
      ['ssh user@host "ls"', 'SSH'],
      ['kill 1234', 'kill'],
      ['killall node', 'killall'],
      ['pkill -f myprocess', 'pkill'],
    ];

    it.each(tier2Commands)('requires approval: %s (%s)', async (command) => {
      let capturedToken: ApprovalToken | undefined;
      const { fw, approval } = makeFirewall((token) => {
        capturedToken = token;
        // Auto-approve to unblock the test
        approval.resolve(token.id, true);
      });

      const decision = await fw.classify('shell.exec', { command });
      expect(decision.tier).toBe(2);
      expect(capturedToken).toBeDefined();
    });

    it('blocks when operator denies Tier 2', async () => {
      const { fw, approval } = makeFirewall((token) => {
        approval.resolve(token.id, false);
      });

      const decision = await fw.classify('shell.exec', { command: 'rm file.txt' });
      expect(decision.tier).toBe(2);
      expect(decision.approved).toBe(false);
    });

    it('writes pending audit entry before awaiting operator', async () => {
      let auditCountAtCallback = 0;
      const { fw, approval, audit } = makeFirewall((token) => {
        auditCountAtCallback = audit.entries.length;
        approval.resolve(token.id, true);
      });

      await fw.classify('shell.exec', { command: 'rm file.txt' });
      expect(auditCountAtCallback).toBeGreaterThan(0);
    });
  });

  // ── Tier 3 shell commands ───────────────────────────────────────────────

  describe('shell.exec — Tier 3 (blocked)', () => {
    const tier3Commands = [
      ['sudo apt update', 'sudo'],
      ['sudo -u root bash', 'sudo'],
      ['useradd newuser', 'useradd'],
      ['usermod -aG docker user', 'usermod'],
      ['userdel user', 'userdel'],
      ['groupadd devs', 'groupadd'],
      ['groupmod -n newname devs', 'groupmod'],
      ['groupdel devs', 'groupdel'],
      ['visudo', 'visudo'],
      ['iptables -A INPUT -p tcp --dport 22 -j ACCEPT', 'iptables'],
      ['ip6tables -F', 'ip6tables'],
      ['nft add table inet myfilter', 'nft'],
      ['ufw allow 80', 'ufw'],
      ['firewall-cmd --zone=public --add-port=80/tcp', 'firewall-cmd'],
      ['netplan apply', 'netplan'],
      ['ifconfig eth0 down', 'ifconfig'],
      ['ip route add default via 192.168.1.1', 'ip route'],
      ['ip link set eth0 up', 'ip link'],
      ['ip addr add 10.0.0.1/24 dev eth0', 'ip addr'],
    ];

    it.each(tier3Commands)('blocks (Tier 3): %s (%s)', async (command) => {
      const { fw } = makeFirewall();
      const decision = await fw.classify('shell.exec', { command });
      expect(decision.tier).toBe(3);
      expect(decision.approved).toBe(false);
    });

    it('writes an audit log entry for Tier 3 rejections', async () => {
      const { fw, audit } = makeFirewall();
      await fw.classify('shell.exec', { command: 'sudo ls' });
      const tier3Entry = audit.entries.find(e => e.tier === 3);
      expect(tier3Entry).toBeDefined();
      expect(tier3Entry?.level).toBe('error');
    });
  });

  // ── Tier 3 has no bypass ─────────────────────────────────────────────────

  describe('Tier 3 — no bypass path exists', () => {
    it('onApprovalRequired is never called for Tier 3 actions', async () => {
      const onApproval = jest.fn();
      const { fw } = makeFirewall(onApproval);

      await fw.classify('shell.exec', { command: 'sudo rm -rf /' });
      expect(onApproval).not.toHaveBeenCalled();
    });
  });

  // ── Package allowlist ────────────────────────────────────────────────────

  describe('package install — allowlist gating', () => {
    let tmpDir: string;
    let allowlistPath: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-fw-'));
      allowlistPath = path.join(tmpDir, 'package-allowlist.json');
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('Tier 1 for allowlisted npm package', async () => {
      const allowlist = new PackageAllowlist(new NoOpAuditLog(), allowlistPath);
      allowlist.add('lodash', 'npm');

      const approval = new ApprovalService();
      const audit = new CapturingAuditLog();
      const fw = new TieredFirewall(approval, audit, allowlist);

      const decision = await fw.classify('shell.exec', { command: 'npm install lodash' });
      expect(decision.tier).toBe(1);
      expect(decision.approved).toBe(true);
    });

    it('Tier 2 for non-allowlisted npm package', async () => {
      const allowlist = new PackageAllowlist(new NoOpAuditLog(), allowlistPath);

      const approval = new ApprovalService();
      const audit = new CapturingAuditLog();
      let capturedToken: ApprovalToken | undefined;
      const fw = new TieredFirewall(approval, audit, allowlist, (token) => {
        capturedToken = token;
        approval.resolve(token.id, true);
      });

      const decision = await fw.classify('shell.exec', { command: 'npm install some-unknown-package' });
      expect(decision.tier).toBe(2);
      expect(capturedToken).toBeDefined();
    });

    it('Tier 1 for allowlisted yarn package', async () => {
      const allowlist = new PackageAllowlist(new NoOpAuditLog(), allowlistPath);
      allowlist.add('axios', 'yarn');

      const approval = new ApprovalService();
      const fw = new TieredFirewall(approval, new NoOpAuditLog(), allowlist);

      const decision = await fw.classify('shell.exec', { command: 'yarn add axios' });
      expect(decision.tier).toBe(1);
    });

    it('Tier 2 for pip install of non-allowlisted package', async () => {
      const allowlist = new PackageAllowlist(new NoOpAuditLog(), allowlistPath);
      const approval = new ApprovalService();
      let capturedToken: ApprovalToken | undefined;
      const fw = new TieredFirewall(approval, new NoOpAuditLog(), allowlist, (token) => {
        capturedToken = token;
        approval.resolve(token.id, true);
      });

      const decision = await fw.classify('shell.exec', { command: 'pip install requests' });
      expect(decision.tier).toBe(2);
      expect(capturedToken).toBeDefined();
    });
  });

  // ── Docker actions ────────────────────────────────────────────────────────

  describe('docker actions', () => {
    it('Tier 1 for docker.list', async () => {
      const { fw } = makeFirewall();
      const decision = await fw.classify('docker.list', { args: ['ps', '-a'] });
      expect(decision.tier).toBe(1);
      expect(decision.approved).toBe(true);
    });

    it('Tier 1 for docker.start', async () => {
      const { fw } = makeFirewall();
      const decision = await fw.classify('docker.start', { args: ['start', 'mycontainer'] });
      expect(decision.tier).toBe(1);
      expect(decision.approved).toBe(true);
    });

    it('Tier 1 for docker.stop', async () => {
      const { fw } = makeFirewall();
      const decision = await fw.classify('docker.stop', { args: ['stop', 'mycontainer'] });
      expect(decision.tier).toBe(1);
      expect(decision.approved).toBe(true);
    });

    it('Tier 2 for docker.prune', async () => {
      const { fw, approval } = makeFirewall((token) => {
        approval.resolve(token.id, true);
      });
      const decision = await fw.classify('docker.prune', { args: ['system', 'prune'] });
      expect(decision.tier).toBe(2);
    });

    it('Tier 2 for docker.rm', async () => {
      const { fw, approval } = makeFirewall((token) => {
        approval.resolve(token.id, true);
      });
      const decision = await fw.classify('docker.rm', { args: ['rm', 'mycontainer'] });
      expect(decision.tier).toBe(2);
    });

    it('Tier 2 for docker.rmi', async () => {
      const { fw, approval } = makeFirewall((token) => {
        approval.resolve(token.id, true);
      });
      const decision = await fw.classify('docker.rmi', { args: ['rmi', 'myimage'] });
      expect(decision.tier).toBe(2);
    });

    it('Tier 3 for docker with --privileged', async () => {
      const { fw } = makeFirewall();
      const decision = await fw.classify('docker.run', { args: ['run', '--privileged'], privileged: true });
      expect(decision.tier).toBe(3);
      expect(decision.approved).toBe(false);
    });

    it('Tier 3 docker: onApprovalRequired is never called', async () => {
      const onApproval = jest.fn();
      const { fw } = makeFirewall(onApproval);
      await fw.classify('docker.run', { privileged: true });
      expect(onApproval).not.toHaveBeenCalled();
    });
  });

  // ── Unknown actions default to Tier 2 ────────────────────────────────────

  describe('unknown actions default to Tier 2', () => {
    it('returns Tier 2 for unrecognised action namespace', async () => {
      const { fw, approval } = makeFirewall((token) => {
        approval.resolve(token.id, true);
      });
      const decision = await fw.classify('unknown.action.type', {});
      expect(decision.tier).toBe(2);
    });
  });

  // ── Audit log entries on every decision ───────────────────────────────────

  describe('audit log — entries written for every decision', () => {
    it('writes an audit entry for Tier 1', async () => {
      const { fw, audit } = makeFirewall();
      await fw.classify('shell.exec', { command: 'ls' });
      expect(audit.entries.length).toBeGreaterThanOrEqual(1);
    });

    it('writes at least two audit entries for Tier 2 (pending + final)', async () => {
      const { fw, approval, audit } = makeFirewall((token) => {
        approval.resolve(token.id, true);
      });
      await fw.classify('shell.exec', { command: 'rm file.txt' });
      // At minimum: pending write + final write
      expect(audit.entries.length).toBeGreaterThanOrEqual(2);
    });

    it('writes an audit entry for Tier 3', async () => {
      const { fw, audit } = makeFirewall();
      await fw.classify('shell.exec', { command: 'sudo ls' });
      expect(audit.entries.length).toBeGreaterThanOrEqual(1);
      expect(audit.entries[0].tier).toBe(3);
    });

    it('all audit entries carry action and tier fields', async () => {
      const { fw, audit } = makeFirewall();
      await fw.classify('docker.list', {});
      for (const entry of audit.entries) {
        expect(entry.action).toBeDefined();
        expect(entry.tier).toBeDefined();
      }
    });
  });

  // ── Approval token integrity ──────────────────────────────────────────────

  describe('approval token integrity', () => {
    it('token approval_id appears in TierDecision', async () => {
      let capturedToken: ApprovalToken | undefined;
      const { fw, approval } = makeFirewall((token) => {
        capturedToken = token;
        approval.resolve(token.id, true);
      });

      const decision = await fw.classify('shell.exec', { command: 'rm file' });
      expect(decision.approval_id).toBe(capturedToken!.id);
    });

    it('token context_hash is a 16-char hex string', async () => {
      let capturedToken: ApprovalToken | undefined;
      const { fw, approval } = makeFirewall((token) => {
        capturedToken = token;
        approval.resolve(token.id, true);
      });

      await fw.classify('shell.exec', { command: 'rm file' });
      expect(capturedToken!.context_hash).toMatch(/^[0-9a-f]{16}$/);
    });
  });
});

// ── ShellEngine + TieredFirewall integration ──────────────────────────────────

describe('ShellEngine + TieredFirewall integration', () => {
  // Import here to avoid circular dependency noise at module level
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { ShellEngine } = require('../../src/apex/shell/ShellEngine');

  it('allows Tier 1 commands through to execution', async () => {
    const approval = new ApprovalService();
    const allowlist = new PackageAllowlist(new NoOpAuditLog());
    const fw = new TieredFirewall(approval, new NoOpAuditLog(), allowlist);
    const engine = new ShellEngine(fw);

    const result = await engine.exec('echo hello');
    expect(result.exit_code).toBe(0);
    expect(result.stdout.trim()).toBe('hello');
  });

  it('throws when firewall blocks a Tier 3 command', async () => {
    const approval = new ApprovalService();
    const allowlist = new PackageAllowlist(new NoOpAuditLog());
    const fw = new TieredFirewall(approval, new NoOpAuditLog(), allowlist);
    const engine = new ShellEngine(fw);

    // sudo is blocked by ShellEngine's own gate first, so use a network command
    // that is Tier 3 but not caught by the sudo check
    await expect(engine.exec('ufw allow 80')).rejects.toThrow('POLICY GATE');
  });
});
