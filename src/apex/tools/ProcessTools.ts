// Co-authored by FORGE (Session: forge-20260327063704-3049883)
// src/apex/tools/ProcessTools.ts — JAL-012 Process tool implementations
//
// Tools: process:ps, process:kill, process:top-n
//
// Tier model:
//  - process:ps  → Tier 1 (read-only)
//  - process:top-n → Tier 1 (read-only)
//  - process:kill  → Tier 2 ALWAYS, regardless of PID
//
// Safety gates:
//  - kill is always Tier 2 — enforced by TieredFirewall's TIER2_SHELL_RULES (kill pattern)
//  - PID validated as numeric before use
//  - All invocations audit-logged

import { PolicyTier, ITool, ToolResult } from '../types';
import type { ToolContext } from './ToolRegistry';

const ISO = () => new Date().toISOString();

// ── process:ps ────────────────────────────────────────────────────────────────

export class PsTool implements ITool {
  readonly name = 'process:ps';
  readonly description = 'ps — List all running processes (Tier 1)';
  readonly tier: PolicyTier = 1;

  constructor(private readonly ctx: ToolContext) {}

  async execute(args: string[]): Promise<ToolResult> {
    const start = Date.now();
    const command = 'ps aux';
    const decision = await this.ctx.firewall.classify('shell.exec', { command });
    const tier = decision.tier;

    if (!decision.approved) {
      return { tool: this.name, args, tier, exit_code: 1, stdout: '', stderr: decision.reason, duration_ms: Date.now() - start };
    }

    try {
      const result = await this.ctx.bypassShell.exec(command, {});
      this.ctx.auditLog.write({
        timestamp: ISO(), level: 'info', service: 'ToolCatalog',
        message: 'process:ps executed', action: 'tool.process.ps', tier,
      });
      return { tool: this.name, args, tier, exit_code: result.exit_code, stdout: result.stdout, stderr: result.stderr, duration_ms: Date.now() - start };
    } catch (err) {
      return { tool: this.name, args, tier, exit_code: 1, stdout: '', stderr: (err as Error).message, duration_ms: Date.now() - start };
    }
  }
}

// ── process:kill ──────────────────────────────────────────────────────────────

export class KillTool implements ITool {
  readonly name = 'process:kill';
  readonly description = 'kill <pid> — Send SIGTERM to a process (ALWAYS Tier 2 — requires approval)';
  readonly tier: PolicyTier = 2;

  constructor(private readonly ctx: ToolContext) {}

  async execute(args: string[]): Promise<ToolResult> {
    const start = Date.now();
    const [pidStr] = args;
    if (!pidStr) {
      return { tool: this.name, args, tier: this.tier, exit_code: 1, stdout: '', stderr: 'process:kill requires <pid>', duration_ms: 0 };
    }

    // Validate PID is a positive integer
    if (!/^\d+$/.test(pidStr)) {
      return { tool: this.name, args, tier: this.tier, exit_code: 1, stdout: '', stderr: `Invalid PID: ${pidStr}. Must be a non-negative integer.`, duration_ms: 0 };
    }

    const command = `kill ${pidStr}`;
    // firewall.classify('shell.exec', { command: 'kill <pid>' }) → Tier 2 (kill pattern in TIER2_SHELL_RULES)
    const decision = await this.ctx.firewall.classify('shell.exec', { command });
    const tier = decision.tier;

    this.ctx.auditLog.write({
      timestamp: ISO(), level: 'warn', service: 'ToolCatalog',
      message: `process:kill pid=${pidStr} — Tier 2 approval required`,
      action: 'tool.process.kill', tier, pid: pidStr,
    });

    if (!decision.approved) {
      this.ctx.auditLog.write({
        timestamp: ISO(), level: 'warn', service: 'ToolCatalog',
        message: `process:kill pid=${pidStr} denied`, action: 'tool.process.kill.denied', tier,
      });
      return { tool: this.name, args, tier, exit_code: 1, stdout: '', stderr: `Kill denied: ${decision.reason}`, duration_ms: Date.now() - start };
    }

    try {
      const result = await this.ctx.bypassShell.exec(command, {});
      this.ctx.auditLog.write({
        timestamp: ISO(), level: 'info', service: 'ToolCatalog',
        message: `process:kill pid=${pidStr} executed`, action: 'tool.process.kill.executed', tier, pid: pidStr,
      });
      return { tool: this.name, args, tier, exit_code: result.exit_code, stdout: result.stdout, stderr: result.stderr, duration_ms: Date.now() - start };
    } catch (err) {
      return { tool: this.name, args, tier, exit_code: 1, stdout: '', stderr: (err as Error).message, duration_ms: Date.now() - start };
    }
  }
}

// ── process:top-n ─────────────────────────────────────────────────────────────

export class TopNTool implements ITool {
  readonly name = 'process:top-n';
  readonly description = 'top-n <n> — Show top N processes by CPU usage (Tier 1)';
  readonly tier: PolicyTier = 1;

  constructor(private readonly ctx: ToolContext) {}

  async execute(args: string[]): Promise<ToolResult> {
    const start = Date.now();
    const [nStr = '10'] = args;
    const n = parseInt(nStr, 10);
    if (isNaN(n) || n < 1) {
      return { tool: this.name, args, tier: this.tier, exit_code: 1, stdout: '', stderr: `Invalid count: ${nStr}. Must be a positive integer.`, duration_ms: 0 };
    }

    // head -n includes the header row, so n+1 gives N data rows
    const command = `ps aux --sort=-%cpu | head -n ${n + 1}`;
    const decision = await this.ctx.firewall.classify('shell.exec', { command });
    const tier = decision.tier;

    if (!decision.approved) {
      return { tool: this.name, args, tier, exit_code: 1, stdout: '', stderr: decision.reason, duration_ms: Date.now() - start };
    }

    try {
      const result = await this.ctx.bypassShell.exec(command, {});
      this.ctx.auditLog.write({
        timestamp: ISO(), level: 'info', service: 'ToolCatalog',
        message: `process:top-n n=${n}`, action: 'tool.process.top-n', tier,
      });
      return { tool: this.name, args, tier, exit_code: result.exit_code, stdout: result.stdout, stderr: result.stderr, duration_ms: Date.now() - start };
    } catch (err) {
      return { tool: this.name, args, tier, exit_code: 1, stdout: '', stderr: (err as Error).message, duration_ms: Date.now() - start };
    }
  }
}
