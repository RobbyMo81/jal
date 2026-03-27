// Co-authored by FORGE (Session: forge-20260327063704-3049883)
// src/apex/tools/FileTools.ts — JAL-012 File tool implementations
//
// Tools: file:read, file:write, file:list, file:search, file:diff
// All subject to PolicyFileOps tier classification.
//
// Safety gates:
//  - No path traversal (enforced by PolicyFileOps.read/write and resolveSafe)
//  - file:write delegates to PolicyFileOps which enforces workspace roots
//  - All invocations audit-logged via firewall.classify() + tool log entry

import { PolicyTier, ITool, ToolResult } from '../types';
import type { ToolContext } from './ToolRegistry';

const ISO = () => new Date().toISOString();

/** Wrap a single-quote safe shell argument. */
function sq(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

// ── file:read ─────────────────────────────────────────────────────────────────

export class ReadFileTool implements ITool {
  readonly name = 'file:read';
  readonly description = 'read <path> — Read a file\'s contents (Tier 1, workspace-policy enforced)';
  readonly tier: PolicyTier = 1;

  constructor(private readonly ctx: ToolContext) {}

  async execute(args: string[]): Promise<ToolResult> {
    const start = Date.now();
    const [rawPath] = args;
    if (!rawPath) {
      return this.err(args, 1, 'file:read requires <path>');
    }

    const result = await this.ctx.fileOps.read(rawPath);
    const duration_ms = Date.now() - start;
    const tier = result.tier_decision.tier;

    this.ctx.auditLog.write({
      timestamp: ISO(),
      level: result.success ? 'info' : 'warn',
      service: 'ToolCatalog',
      message: `file:read ${rawPath}`,
      action: 'tool.file.read',
      tier,
      outcome: result.success ? 'success' : 'denied',
    });

    if (!result.success) {
      return { tool: this.name, args, tier, exit_code: 1, stdout: '', stderr: result.error ?? 'read failed', duration_ms };
    }
    return { tool: this.name, args, tier, exit_code: 0, stdout: result.content ?? '', stderr: '', duration_ms };
  }

  private err(args: string[], exit_code: number, stderr: string): ToolResult {
    return { tool: this.name, args, tier: this.tier, exit_code, stdout: '', stderr, duration_ms: 0 };
  }
}

// ── file:write ────────────────────────────────────────────────────────────────

export class WriteFileTool implements ITool {
  readonly name = 'file:write';
  readonly description = 'write <path> <content> — Write content to a file (Tier 1 in workspace, Tier 2 outside)';
  readonly tier: PolicyTier = 1;

  constructor(private readonly ctx: ToolContext) {}

  async execute(args: string[]): Promise<ToolResult> {
    const start = Date.now();
    const [rawPath, ...rest] = args;
    if (!rawPath) {
      return this.err(args, 1, 'file:write requires <path> <content>');
    }
    const content = rest.join(' ');

    const result = await this.ctx.fileOps.write(rawPath, content);
    const duration_ms = Date.now() - start;
    const tier = result.tier_decision.tier;

    this.ctx.auditLog.write({
      timestamp: ISO(),
      level: result.success ? 'info' : 'warn',
      service: 'ToolCatalog',
      message: `file:write ${rawPath}`,
      action: 'tool.file.write',
      tier,
      outcome: result.success ? 'success' : 'denied',
    });

    if (!result.success) {
      return { tool: this.name, args, tier, exit_code: 1, stdout: '', stderr: result.error ?? 'write failed', duration_ms };
    }
    return { tool: this.name, args, tier, exit_code: 0, stdout: `Written: ${rawPath}`, stderr: '', duration_ms };
  }

  private err(args: string[], exit_code: number, stderr: string): ToolResult {
    return { tool: this.name, args, tier: this.tier, exit_code, stdout: '', stderr, duration_ms: 0 };
  }
}

// ── file:list ─────────────────────────────────────────────────────────────────

export class ListDirTool implements ITool {
  readonly name = 'file:list';
  readonly description = 'list <dir> — List directory contents (Tier 1)';
  readonly tier: PolicyTier = 1;

  constructor(private readonly ctx: ToolContext) {}

  async execute(args: string[]): Promise<ToolResult> {
    const start = Date.now();
    const [rawDir = '.'] = args;
    const command = `ls -la ${sq(rawDir)}`;

    const decision = await this.ctx.firewall.classify('shell.exec', { command });
    const tier = decision.tier;

    if (!decision.approved) {
      this.logAudit('warn', 'file:list denied', 'tool.file.list', tier, args);
      return { tool: this.name, args, tier, exit_code: 1, stdout: '', stderr: decision.reason, duration_ms: Date.now() - start };
    }

    try {
      const result = await this.ctx.bypassShell.exec(command, {});
      this.logAudit(result.exit_code === 0 ? 'info' : 'warn', `file:list ${rawDir}`, 'tool.file.list', tier, args);
      return { tool: this.name, args, tier, exit_code: result.exit_code, stdout: result.stdout, stderr: result.stderr, duration_ms: Date.now() - start };
    } catch (err) {
      this.logAudit('warn', `file:list error: ${(err as Error).message}`, 'tool.file.list', tier, args);
      return { tool: this.name, args, tier, exit_code: 1, stdout: '', stderr: (err as Error).message, duration_ms: Date.now() - start };
    }
  }

  private logAudit(level: 'info' | 'warn', message: string, action: string, tier: PolicyTier, args: string[]): void {
    this.ctx.auditLog.write({ timestamp: ISO(), level, service: 'ToolCatalog', message, action, tier, tool_args: args });
  }
}

// ── file:search ───────────────────────────────────────────────────────────────

export class SearchFilesTool implements ITool {
  readonly name = 'file:search';
  readonly description = 'search <pattern> <dir> — Grep recursively for pattern in dir (Tier 1)';
  readonly tier: PolicyTier = 1;

  constructor(private readonly ctx: ToolContext) {}

  async execute(args: string[]): Promise<ToolResult> {
    const start = Date.now();
    const [pattern, dir = '.'] = args;
    if (!pattern) {
      return { tool: this.name, args, tier: this.tier, exit_code: 1, stdout: '', stderr: 'file:search requires <pattern> [<dir>]', duration_ms: 0 };
    }
    const command = `grep -r ${sq(pattern)} ${sq(dir)}`;

    const decision = await this.ctx.firewall.classify('shell.exec', { command });
    const tier = decision.tier;

    if (!decision.approved) {
      this.logAudit('warn', 'file:search denied', tier, args);
      return { tool: this.name, args, tier, exit_code: 1, stdout: '', stderr: decision.reason, duration_ms: Date.now() - start };
    }

    try {
      const result = await this.ctx.bypassShell.exec(command, {});
      this.logAudit('info', `file:search "${pattern}" in ${dir}`, tier, args);
      return { tool: this.name, args, tier, exit_code: result.exit_code, stdout: result.stdout, stderr: result.stderr, duration_ms: Date.now() - start };
    } catch (err) {
      this.logAudit('warn', `file:search error: ${(err as Error).message}`, tier, args);
      return { tool: this.name, args, tier, exit_code: 1, stdout: '', stderr: (err as Error).message, duration_ms: Date.now() - start };
    }
  }

  private logAudit(level: 'info' | 'warn', message: string, tier: PolicyTier, args: string[]): void {
    this.ctx.auditLog.write({ timestamp: ISO(), level, service: 'ToolCatalog', message, action: 'tool.file.search', tier, tool_args: args });
  }
}

// ── file:diff ─────────────────────────────────────────────────────────────────

export class DiffFilesTool implements ITool {
  readonly name = 'file:diff';
  readonly description = 'diff <path1> <path2> — Show diff between two files (Tier 1)';
  readonly tier: PolicyTier = 1;

  constructor(private readonly ctx: ToolContext) {}

  async execute(args: string[]): Promise<ToolResult> {
    const start = Date.now();
    const [path1, path2] = args;
    if (!path1 || !path2) {
      return { tool: this.name, args, tier: this.tier, exit_code: 1, stdout: '', stderr: 'file:diff requires <path1> <path2>', duration_ms: 0 };
    }
    const command = `diff ${sq(path1)} ${sq(path2)}`;

    const decision = await this.ctx.firewall.classify('shell.exec', { command });
    const tier = decision.tier;

    if (!decision.approved) {
      this.logAudit('warn', 'file:diff denied', tier, args);
      return { tool: this.name, args, tier, exit_code: 1, stdout: '', stderr: decision.reason, duration_ms: Date.now() - start };
    }

    try {
      const result = await this.ctx.bypassShell.exec(command, {});
      this.logAudit('info', `file:diff ${path1} ${path2}`, tier, args);
      // diff exits 1 when files differ (not an error), exits 2 on error
      return { tool: this.name, args, tier, exit_code: result.exit_code, stdout: result.stdout, stderr: result.stderr, duration_ms: Date.now() - start };
    } catch (err) {
      this.logAudit('warn', `file:diff error: ${(err as Error).message}`, tier, args);
      return { tool: this.name, args, tier, exit_code: 1, stdout: '', stderr: (err as Error).message, duration_ms: Date.now() - start };
    }
  }

  private logAudit(level: 'info' | 'warn', message: string, tier: PolicyTier, args: string[]): void {
    this.ctx.auditLog.write({ timestamp: ISO(), level, service: 'ToolCatalog', message, action: 'tool.file.diff', tier, tool_args: args });
  }
}
