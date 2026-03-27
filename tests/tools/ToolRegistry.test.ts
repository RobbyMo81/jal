// Co-authored by FORGE (Session: forge-20260327063704-3049883)
// tests/tools/ToolRegistry.test.ts — JAL-012 Tool catalog tests
//
// Tests cover:
//  - ToolRegistry: register, get, list, catalog()
//  - FileTools: read, write, list, search, diff
//  - ProcessTools: ps, kill (Tier 2 enforcement), top-n
//  - NetworkTools: ping, port-check, curl (GET-only safety gate)
//  - LogTools: tail, log-grep
//  - SystemTools: env (secret redaction), uptime, df, free, which

import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { ToolRegistry } from '../../src/apex/tools/ToolRegistry';
import { ReadFileTool, WriteFileTool, ListDirTool, SearchFilesTool, DiffFilesTool } from '../../src/apex/tools/FileTools';
import { PsTool, KillTool, TopNTool } from '../../src/apex/tools/ProcessTools';
import { PingTool, PortCheckTool, CurlTool } from '../../src/apex/tools/NetworkTools';
import { TailTool, LogGrepTool } from '../../src/apex/tools/LogTools';
import { EnvTool, UptimeTool, DfTool, FreeTool, WhichTool } from '../../src/apex/tools/SystemTools';
import { NoOpAuditLog } from '../../src/apex/policy/AuditLog';
import { ShellEngine } from '../../src/apex/shell/ShellEngine';
import { PolicyFileOps } from '../../src/apex/fileops/PolicyFileOps';
import { WorkspaceRootsConfig } from '../../src/apex/fileops/WorkspaceRootsConfig';
import { ApprovalService } from '../../src/apex/policy/ApprovalService';
import { TieredFirewall } from '../../src/apex/policy/TieredFirewall';
import { PackageAllowlist } from '../../src/apex/policy/PackageAllowlist';
import { ITool, ToolResult, PolicyTier, TierDecision } from '../../src/apex/types';

// ── Test doubles ──────────────────────────────────────────────────────────────

/** A firewall that always approves Tier 1. */
class Tier1Firewall extends TieredFirewall {
  constructor() {
    const audit = new NoOpAuditLog();
    const approvalService = new ApprovalService();
    const allowlist = new PackageAllowlist(audit);
    super(approvalService, audit, allowlist);
  }
}

/** A firewall that always denies (returns Tier 3 blocked). */
class DenyFirewall {
  async classify(action: string): Promise<TierDecision> {
    return {
      tier: 3 as PolicyTier,
      action,
      reason: 'DenyFirewall: all actions blocked',
      approved: false,
      decided_at: new Date().toISOString(),
    };
  }
}

/** A firewall that auto-approves Tier 2 actions (for kill tests). */
class AutoApproveTier2Firewall {
  async classify(action: string, context: Record<string, unknown>): Promise<TierDecision> {
    const command = String(context['command'] ?? '');
    const isKill = /(?:^|\s)kill(?:\s|$)/.test(command);
    return {
      tier: isKill ? (2 as PolicyTier) : (1 as PolicyTier),
      action,
      reason: isKill ? 'Kill auto-approved for test' : 'Tier 1 auto-approved',
      approved: true,
      decided_at: new Date().toISOString(),
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-tools-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function buildCtx(firewall?: unknown) {
  const auditLog = new NoOpAuditLog();
  const bypassShell = new ShellEngine(); // no firewall
  const workspaceRoots = new WorkspaceRootsConfig(auditLog, path.join(tmpDir, 'workspace-roots.json'));
  // Add tmpDir as a workspace root so file:write is Tier 1
  workspaceRoots.add(tmpDir);
  const approvalService = new ApprovalService();
  const fileOps = new PolicyFileOps(workspaceRoots, approvalService, auditLog);
  const fw = (firewall as TieredFirewall) ?? new Tier1Firewall();
  return { bypassShell, fileOps, auditLog, firewall: fw };
}

// ── ToolRegistry ──────────────────────────────────────────────────────────────

describe('ToolRegistry', () => {
  it('register and get a tool', () => {
    const registry = new ToolRegistry();
    const tool: ITool = {
      name: 'test:noop',
      description: 'Test tool',
      tier: 1,
      execute: async () => ({ tool: 'test:noop', args: [], tier: 1, exit_code: 0, stdout: 'ok', stderr: '', duration_ms: 0 }),
    };
    registry.register(tool);
    expect(registry.get('test:noop')).toBe(tool);
    expect(registry.get('missing')).toBeUndefined();
  });

  it('list returns tools sorted by name', () => {
    const registry = new ToolRegistry();
    const make = (name: string): ITool => ({
      name, description: '', tier: 1,
      execute: async () => ({ tool: name, args: [], tier: 1, exit_code: 0, stdout: '', stderr: '', duration_ms: 0 }),
    });
    registry.register(make('zz:tool'));
    registry.register(make('aa:tool'));
    registry.register(make('mm:tool'));
    expect(registry.list().map((t) => t.name)).toEqual(['aa:tool', 'mm:tool', 'zz:tool']);
  });

  it('catalog() produces formatted string', () => {
    const registry = new ToolRegistry();
    const tool: ITool = {
      name: 'file:read',
      description: 'Read a file',
      tier: 1,
      execute: async () => ({ tool: 'file:read', args: [], tier: 1, exit_code: 0, stdout: '', stderr: '', duration_ms: 0 }),
    };
    registry.register(tool);
    const cat = registry.catalog();
    expect(cat).toContain('file:read');
    expect(cat).toContain('Read a file');
    expect(cat).toContain('[Tier 1]');
  });

  it('catalog() with no tools returns placeholder', () => {
    const registry = new ToolRegistry();
    expect(registry.catalog()).toContain('none registered');
  });
});

// ── FileTools ─────────────────────────────────────────────────────────────────

describe('FileTools', () => {
  it('file:read reads an existing file', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(filePath, 'hello world');
    const tool = new ReadFileTool(buildCtx());
    const result = await tool.execute([filePath]);
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain('hello world');
    expect(result.tool).toBe('file:read');
    expect(result.tier).toBe(1);
  });

  it('file:read returns exit_code=1 for non-existent file', async () => {
    const tool = new ReadFileTool(buildCtx());
    const result = await tool.execute(['/nonexistent/path/file.txt']);
    expect(result.exit_code).toBe(1);
    expect(result.stderr).toBeTruthy();
  });

  it('file:read returns exit_code=1 with no args', async () => {
    const tool = new ReadFileTool(buildCtx());
    const result = await tool.execute([]);
    expect(result.exit_code).toBe(1);
    expect(result.stderr).toMatch(/requires/i);
  });

  it('file:write writes content to a file in workspace', async () => {
    const filePath = path.join(tmpDir, 'out.txt');
    const tool = new WriteFileTool(buildCtx());
    const result = await tool.execute([filePath, 'content here']);
    expect(result.exit_code).toBe(0);
    expect(fs.readFileSync(filePath, 'utf8')).toBe('content here');
  });

  it('file:write returns exit_code=1 with no args', async () => {
    const tool = new WriteFileTool(buildCtx());
    const result = await tool.execute([]);
    expect(result.exit_code).toBe(1);
    expect(result.stderr).toMatch(/requires/i);
  });

  it('file:list lists a directory', async () => {
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'a');
    const tool = new ListDirTool(buildCtx());
    const result = await tool.execute([tmpDir]);
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain('a.txt');
  });

  it('file:list uses current dir when no args', async () => {
    const tool = new ListDirTool(buildCtx());
    const result = await tool.execute([]);
    // ls . should succeed
    expect(result.exit_code).toBe(0);
  });

  it('file:search finds a pattern in a directory', async () => {
    fs.writeFileSync(path.join(tmpDir, 'foo.txt'), 'hello world\nfoo bar');
    const tool = new SearchFilesTool(buildCtx());
    const result = await tool.execute(['hello', tmpDir]);
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain('hello world');
  });

  it('file:search returns exit_code=1 with no args', async () => {
    const tool = new SearchFilesTool(buildCtx());
    const result = await tool.execute([]);
    expect(result.exit_code).toBe(1);
    expect(result.stderr).toMatch(/requires/i);
  });

  it('file:diff shows diff between two files', async () => {
    const f1 = path.join(tmpDir, 'a.txt');
    const f2 = path.join(tmpDir, 'b.txt');
    fs.writeFileSync(f1, 'line1\nline2\n');
    fs.writeFileSync(f2, 'line1\nline3\n');
    const tool = new DiffFilesTool(buildCtx());
    const result = await tool.execute([f1, f2]);
    // diff exits 1 when files differ (expected)
    expect(result.stdout).toContain('line');
    expect(result.tool).toBe('file:diff');
  });

  it('file:diff returns exit_code=1 with insufficient args', async () => {
    const tool = new DiffFilesTool(buildCtx());
    const result = await tool.execute(['/tmp/a.txt']);
    expect(result.exit_code).toBe(1);
    expect(result.stderr).toMatch(/requires/i);
  });
});

// ── ProcessTools ──────────────────────────────────────────────────────────────

describe('ProcessTools', () => {
  it('process:ps lists processes', async () => {
    const tool = new PsTool(buildCtx());
    const result = await tool.execute([]);
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain('PID');
    expect(result.tier).toBe(1);
  });

  it('process:top-n shows top N processes', async () => {
    const tool = new TopNTool(buildCtx());
    const result = await tool.execute(['5']);
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain('PID');
  });

  it('process:top-n returns error for invalid n', async () => {
    const tool = new TopNTool(buildCtx());
    const result = await tool.execute(['not-a-number']);
    expect(result.exit_code).toBe(1);
    expect(result.stderr).toMatch(/invalid/i);
  });

  it('process:top-n uses default 10 when no args', async () => {
    const tool = new TopNTool(buildCtx());
    const result = await tool.execute([]);
    expect(result.exit_code).toBe(0);
  });

  it('process:kill requires pid arg', async () => {
    const tool = new KillTool(buildCtx());
    const result = await tool.execute([]);
    expect(result.exit_code).toBe(1);
    expect(result.stderr).toMatch(/requires/i);
  });

  it('process:kill rejects non-numeric pid', async () => {
    const tool = new KillTool(buildCtx());
    const result = await tool.execute(['abc']);
    expect(result.exit_code).toBe(1);
    expect(result.stderr).toMatch(/invalid pid/i);
  });

  it('process:kill always Tier 2 (denied when firewall denies)', async () => {
    const ctx = buildCtx(new DenyFirewall());
    const tool = new KillTool(ctx);
    const result = await tool.execute(['99999']);
    expect(result.tier).toBe(3); // DenyFirewall returns Tier 3
    expect(result.exit_code).toBe(1);
  });

  it('process:kill executes when Tier 2 approved', async () => {
    // Use a process that cannot be killed (no such process) — exit_code 1 is ok
    // We just want to verify that execution proceeds when firewall approves
    const ctx = buildCtx(new AutoApproveTier2Firewall() as unknown as TieredFirewall);
    const tool = new KillTool(ctx);
    // Use an unlikely PID — kill will return non-zero since process doesn't exist
    // but the tool itself executed (no denial)
    const result = await tool.execute(['99998']);
    expect(result.tier).toBe(2);
    // The kill itself may fail (no such process) but we should have attempted it
    expect(result.tool).toBe('process:kill');
  });
});

// ── NetworkTools ──────────────────────────────────────────────────────────────

describe('NetworkTools', () => {
  it('network:ping requires host', async () => {
    const tool = new PingTool(buildCtx());
    const result = await tool.execute([]);
    expect(result.exit_code).toBe(1);
    expect(result.stderr).toMatch(/requires/i);
  });

  it('network:ping rejects unsafe host', async () => {
    const tool = new PingTool(buildCtx());
    const result = await tool.execute(['host; rm -rf /']);
    expect(result.exit_code).toBe(1);
    expect(result.stderr).toMatch(/invalid host/i);
  });

  it('network:port-check requires host and port', async () => {
    const tool = new PortCheckTool(buildCtx());
    expect((await tool.execute([])).exit_code).toBe(1);
    expect((await tool.execute(['localhost'])).exit_code).toBe(1);
  });

  it('network:port-check rejects out-of-range port', async () => {
    const tool = new PortCheckTool(buildCtx());
    const result = await tool.execute(['localhost', '99999']);
    expect(result.exit_code).toBe(1);
    expect(result.stderr).toMatch(/invalid port/i);
  });

  it('network:curl requires url', async () => {
    const tool = new CurlTool(buildCtx());
    const result = await tool.execute([]);
    expect(result.exit_code).toBe(1);
    expect(result.stderr).toMatch(/requires/i);
  });

  it('network:curl rejects non-http URLs (SAFETY GATE)', async () => {
    const tool = new CurlTool(buildCtx());
    const result = await tool.execute(['ftp://example.com/file']);
    expect(result.exit_code).toBe(1);
    expect(result.stderr).toMatch(/http\/https/i);
  });

  it('network:curl rejects file:// URL (SAFETY GATE)', async () => {
    const tool = new CurlTool(buildCtx());
    const result = await tool.execute(['file:///etc/passwd']);
    expect(result.exit_code).toBe(1);
    expect(result.stderr).toMatch(/http\/https/i);
  });
});

// ── LogTools ──────────────────────────────────────────────────────────────────

describe('LogTools', () => {
  it('log:tail requires path', async () => {
    const tool = new TailTool(buildCtx());
    const result = await tool.execute([]);
    expect(result.exit_code).toBe(1);
    expect(result.stderr).toMatch(/requires/i);
  });

  it('log:tail rejects invalid line count', async () => {
    const tool = new TailTool(buildCtx());
    const result = await tool.execute(['/tmp/test.log', 'abc']);
    expect(result.exit_code).toBe(1);
    expect(result.stderr).toMatch(/invalid line count/i);
  });

  it('log:tail returns last N lines of a file', async () => {
    const logFile = path.join(tmpDir, 'test.log');
    fs.writeFileSync(logFile, 'line1\nline2\nline3\nline4\nline5\n');
    const tool = new TailTool(buildCtx());
    const result = await tool.execute([logFile, '3']);
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain('line3');
    expect(result.stdout).toContain('line5');
    expect(result.stdout).not.toContain('line1');
  });

  it('log:log-grep requires pattern and path', async () => {
    const tool = new LogGrepTool(buildCtx());
    expect((await tool.execute([])).exit_code).toBe(1);
    expect((await tool.execute(['pattern'])).exit_code).toBe(1);
  });

  it('log:log-grep finds pattern in log file', async () => {
    const logFile = path.join(tmpDir, 'app.log');
    fs.writeFileSync(logFile, 'INFO: start\nERROR: something failed\nINFO: done\n');
    const tool = new LogGrepTool(buildCtx());
    const result = await tool.execute(['ERROR', logFile]);
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain('ERROR');
  });

  it('log:log-grep exit_code=1 when no matches (not an error)', async () => {
    const logFile = path.join(tmpDir, 'empty.log');
    fs.writeFileSync(logFile, 'INFO: nothing relevant\n');
    const tool = new LogGrepTool(buildCtx());
    const result = await tool.execute(['CRITICAL', logFile]);
    // grep returns 1 when no matches
    expect(result.exit_code).toBe(1);
    expect(result.stderr).toBe('');
  });
});

// ── SystemTools ───────────────────────────────────────────────────────────────

describe('SystemTools', () => {
  it('system:env redacts secret values (SAFETY GATE)', async () => {
    const origEnv = process.env;
    process.env = {
      ...process.env,
      MY_TOKEN: 'super-secret-value',
      MY_PASSWORD: 'hunter2',
      MY_API_KEY: 'sk-1234',
      SAFE_VAR: 'visible-value',
    };
    try {
      const tool = new EnvTool(buildCtx());
      const result = await tool.execute([]);
      expect(result.exit_code).toBe(0);
      expect(result.stdout).toContain('MY_TOKEN=[REDACTED]');
      expect(result.stdout).toContain('MY_PASSWORD=[REDACTED]');
      expect(result.stdout).toContain('MY_API_KEY=[REDACTED]');
      expect(result.stdout).toContain('SAFE_VAR=visible-value');
      expect(result.stdout).not.toContain('super-secret-value');
      expect(result.stdout).not.toContain('hunter2');
      expect(result.stdout).not.toContain('sk-1234');
    } finally {
      process.env = origEnv;
    }
  });

  it('system:uptime returns output', async () => {
    const tool = new UptimeTool(buildCtx());
    const result = await tool.execute([]);
    expect(result.exit_code).toBe(0);
    expect(result.stdout.length).toBeGreaterThan(0);
    expect(result.tier).toBe(1);
  });

  it('system:df returns disk info', async () => {
    const tool = new DfTool(buildCtx());
    const result = await tool.execute([]);
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain('Filesystem');
  });

  it('system:free returns memory info', async () => {
    const tool = new FreeTool(buildCtx());
    const result = await tool.execute([]);
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain('Mem');
  });

  it('system:which requires binary name', async () => {
    const tool = new WhichTool(buildCtx());
    const result = await tool.execute([]);
    expect(result.exit_code).toBe(1);
    expect(result.stderr).toMatch(/requires/i);
  });

  it('system:which rejects unsafe binary name', async () => {
    const tool = new WhichTool(buildCtx());
    const result = await tool.execute(['bash; rm -rf /']);
    expect(result.exit_code).toBe(1);
    expect(result.stderr).toMatch(/invalid binary/i);
  });

  it('system:which finds bash', async () => {
    const tool = new WhichTool(buildCtx());
    const result = await tool.execute(['bash']);
    expect(result.exit_code).toBe(0);
    expect(result.stdout).toContain('bash');
  });
});

// ── ApexRuntime wiring ────────────────────────────────────────────────────────

describe('ApexRuntime ToolRegistry wiring', () => {
  it('ApexRuntime exposes toolRegistry with all tools registered', async () => {
    // Import dynamically to avoid circular dep issues in test
    const { ApexRuntime } = await import('../../src/apex/runtime/ApexRuntime');
    const runtime = new ApexRuntime({ auditLog: new NoOpAuditLog(), stateDir: tmpDir });
    const registry = runtime.toolRegistry;

    // Verify all expected tools are present
    const expectedTools = [
      'file:read', 'file:write', 'file:list', 'file:search', 'file:diff',
      'process:ps', 'process:kill', 'process:top-n',
      'network:ping', 'network:port-check', 'network:curl',
      'log:tail', 'log:log-grep',
      'system:env', 'system:uptime', 'system:df', 'system:free', 'system:which',
    ];

    for (const name of expectedTools) {
      expect(registry.get(name)).toBeDefined();
    }

    expect(registry.list().length).toBe(expectedTools.length);
  });

  it('ToolRegistry.catalog() includes all tool names', async () => {
    const { ApexRuntime } = await import('../../src/apex/runtime/ApexRuntime');
    const runtime = new ApexRuntime({ auditLog: new NoOpAuditLog(), stateDir: tmpDir });
    const catalog = runtime.toolRegistry.catalog();

    expect(catalog).toContain('file:read');
    expect(catalog).toContain('process:kill');
    expect(catalog).toContain('network:curl');
    expect(catalog).toContain('log:tail');
    expect(catalog).toContain('system:env');
  });
});
