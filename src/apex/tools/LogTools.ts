// Co-authored by FORGE (Session: forge-20260327063704-3049883)
// src/apex/tools/LogTools.ts — JAL-012 Log tool implementations
//
// Tools: log:tail, log:log-grep
// Both are Tier 1 read-only operations.
//
// Safety gates:
//  - Both tools are read-only — Tier 1 auto-approved
//  - Line count validated as positive integer
//  - All invocations audit-logged

import { PolicyTier, ITool, ToolResult } from '../types';
import type { ToolContext } from './ToolRegistry';

const ISO = () => new Date().toISOString();

function sq(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

// ── log:tail ──────────────────────────────────────────────────────────────────

export class TailTool implements ITool {
  readonly name = 'log:tail';
  readonly description = 'tail <path> <lines> — Show last N lines of a file (Tier 1)';
  readonly tier: PolicyTier = 1;

  constructor(private readonly ctx: ToolContext) {}

  async execute(args: string[]): Promise<ToolResult> {
    const start = Date.now();
    const [rawPath, linesStr = '50'] = args;
    if (!rawPath) {
      return this.err(args, 'log:tail requires <path> [<lines>]');
    }
    const lines = parseInt(linesStr, 10);
    if (isNaN(lines) || lines < 1) {
      return this.err(args, `Invalid line count: ${linesStr}. Must be a positive integer.`);
    }

    const command = `tail -n ${lines} ${sq(rawPath)}`;
    const decision = await this.ctx.firewall.classify('shell.exec', { command });
    const tier = decision.tier;

    if (!decision.approved) {
      this.log('warn', `log:tail denied: ${rawPath}`, tier, args);
      return { tool: this.name, args, tier, exit_code: 1, stdout: '', stderr: decision.reason, duration_ms: Date.now() - start };
    }

    try {
      const result = await this.ctx.bypassShell.exec(command, {});
      this.log('info', `log:tail ${rawPath} lines=${lines}`, tier, args);
      return { tool: this.name, args, tier, exit_code: result.exit_code, stdout: result.stdout, stderr: result.stderr, duration_ms: Date.now() - start };
    } catch (err) {
      return { tool: this.name, args, tier, exit_code: 1, stdout: '', stderr: (err as Error).message, duration_ms: Date.now() - start };
    }
  }

  private err(args: string[], stderr: string): ToolResult {
    return { tool: this.name, args, tier: this.tier, exit_code: 1, stdout: '', stderr, duration_ms: 0 };
  }

  private log(level: 'info' | 'warn', message: string, tier: PolicyTier, args: string[]): void {
    this.ctx.auditLog.write({ timestamp: ISO(), level, service: 'ToolCatalog', message, action: 'tool.log.tail', tier, tool_args: args });
  }
}

// ── log:log-grep ──────────────────────────────────────────────────────────────

export class LogGrepTool implements ITool {
  readonly name = 'log:log-grep';
  readonly description = 'log-grep <pattern> <path> — Search a log file for pattern (Tier 1)';
  readonly tier: PolicyTier = 1;

  constructor(private readonly ctx: ToolContext) {}

  async execute(args: string[]): Promise<ToolResult> {
    const start = Date.now();
    const [pattern, rawPath] = args;
    if (!pattern || !rawPath) {
      return this.err(args, 'log:log-grep requires <pattern> <path>');
    }

    const command = `grep ${sq(pattern)} ${sq(rawPath)}`;
    const decision = await this.ctx.firewall.classify('shell.exec', { command });
    const tier = decision.tier;

    if (!decision.approved) {
      this.log('warn', `log:log-grep denied: ${rawPath}`, tier, args);
      return { tool: this.name, args, tier, exit_code: 1, stdout: '', stderr: decision.reason, duration_ms: Date.now() - start };
    }

    try {
      const result = await this.ctx.bypassShell.exec(command, {});
      this.log('info', `log:log-grep "${pattern}" in ${rawPath}`, tier, args);
      // grep exits 1 when no matches found (not an error condition)
      return { tool: this.name, args, tier, exit_code: result.exit_code, stdout: result.stdout, stderr: result.stderr, duration_ms: Date.now() - start };
    } catch (err) {
      return { tool: this.name, args, tier, exit_code: 1, stdout: '', stderr: (err as Error).message, duration_ms: Date.now() - start };
    }
  }

  private err(args: string[], stderr: string): ToolResult {
    return { tool: this.name, args, tier: this.tier, exit_code: 1, stdout: '', stderr, duration_ms: 0 };
  }

  private log(level: 'info' | 'warn', message: string, tier: PolicyTier, args: string[]): void {
    this.ctx.auditLog.write({ timestamp: ISO(), level, service: 'ToolCatalog', message, action: 'tool.log.grep', tier, tool_args: args });
  }
}
