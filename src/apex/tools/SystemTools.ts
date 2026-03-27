// Co-authored by FORGE (Session: forge-20260327063704-3049883)
// src/apex/tools/SystemTools.ts — JAL-012 System tool implementations
//
// Tools: system:env, system:uptime, system:df, system:free, system:which
//
// Safety gates:
//  - system:env redacts values where key matches secret patterns
//    (token, key, password, secret, api, auth, credential, private)
//  - All tools are Tier 1 read-only
//  - system:which: binary name validated (alphanumeric, dot, hyphen only)
//  - All invocations audit-logged

import { PolicyTier, ITool, ToolResult } from '../types';
import type { ToolContext } from './ToolRegistry';

const ISO = () => new Date().toISOString();

/**
 * Keys matching this pattern have their values redacted in system:env output.
 * Case-insensitive match against the environment variable NAME.
 */
const SECRET_KEY_RE = /token|key|password|secret|api|auth|credential|private/i;

function sq(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

/** Safe binary name: only alphanumeric, dot, hyphen, underscore. */
const SAFE_BIN_RE = /^[a-zA-Z0-9._-]+$/;

// ── system:env ────────────────────────────────────────────────────────────────

export class EnvTool implements ITool {
  readonly name = 'system:env';
  readonly description = 'env — Show environment variables (Tier 1; secrets redacted)';
  readonly tier: PolicyTier = 1;

  constructor(private readonly ctx: ToolContext) {}

  async execute(args: string[]): Promise<ToolResult> {
    const start = Date.now();

    // Read process.env directly — no shell needed, no injection risk
    const lines: string[] = [];
    for (const [k, v] of Object.entries(process.env)) {
      const value = v ?? '';
      const display = SECRET_KEY_RE.test(k) ? '[REDACTED]' : value;
      lines.push(`${k}=${display}`);
    }
    lines.sort();
    const stdout = lines.join('\n') + '\n';

    this.ctx.auditLog.write({
      timestamp: ISO(), level: 'info', service: 'ToolCatalog',
      message: 'system:env executed (secrets redacted)', action: 'tool.system.env', tier: this.tier,
    });

    return { tool: this.name, args, tier: this.tier, exit_code: 0, stdout, stderr: '', duration_ms: Date.now() - start };
  }
}

// ── system:uptime ─────────────────────────────────────────────────────────────

export class UptimeTool implements ITool {
  readonly name = 'system:uptime';
  readonly description = 'uptime — Show system uptime and load averages (Tier 1)';
  readonly tier: PolicyTier = 1;

  constructor(private readonly ctx: ToolContext) {}

  async execute(args: string[]): Promise<ToolResult> {
    const start = Date.now();
    const command = 'uptime';
    const decision = await this.ctx.firewall.classify('shell.exec', { command });
    const tier = decision.tier;

    if (!decision.approved) {
      return { tool: this.name, args, tier, exit_code: 1, stdout: '', stderr: decision.reason, duration_ms: Date.now() - start };
    }

    try {
      const result = await this.ctx.bypassShell.exec(command, {});
      this.ctx.auditLog.write({ timestamp: ISO(), level: 'info', service: 'ToolCatalog', message: 'system:uptime', action: 'tool.system.uptime', tier });
      return { tool: this.name, args, tier, exit_code: result.exit_code, stdout: result.stdout, stderr: result.stderr, duration_ms: Date.now() - start };
    } catch (err) {
      return { tool: this.name, args, tier, exit_code: 1, stdout: '', stderr: (err as Error).message, duration_ms: Date.now() - start };
    }
  }
}

// ── system:df ─────────────────────────────────────────────────────────────────

export class DfTool implements ITool {
  readonly name = 'system:df';
  readonly description = 'df — Show disk usage for all mounts (Tier 1)';
  readonly tier: PolicyTier = 1;

  constructor(private readonly ctx: ToolContext) {}

  async execute(args: string[]): Promise<ToolResult> {
    const start = Date.now();
    const command = 'df -h';
    const decision = await this.ctx.firewall.classify('shell.exec', { command });
    const tier = decision.tier;

    if (!decision.approved) {
      return { tool: this.name, args, tier, exit_code: 1, stdout: '', stderr: decision.reason, duration_ms: Date.now() - start };
    }

    try {
      const result = await this.ctx.bypassShell.exec(command, {});
      this.ctx.auditLog.write({ timestamp: ISO(), level: 'info', service: 'ToolCatalog', message: 'system:df', action: 'tool.system.df', tier });
      return { tool: this.name, args, tier, exit_code: result.exit_code, stdout: result.stdout, stderr: result.stderr, duration_ms: Date.now() - start };
    } catch (err) {
      return { tool: this.name, args, tier, exit_code: 1, stdout: '', stderr: (err as Error).message, duration_ms: Date.now() - start };
    }
  }
}

// ── system:free ───────────────────────────────────────────────────────────────

export class FreeTool implements ITool {
  readonly name = 'system:free';
  readonly description = 'free — Show memory usage (Tier 1)';
  readonly tier: PolicyTier = 1;

  constructor(private readonly ctx: ToolContext) {}

  async execute(args: string[]): Promise<ToolResult> {
    const start = Date.now();
    const command = 'free -h';
    const decision = await this.ctx.firewall.classify('shell.exec', { command });
    const tier = decision.tier;

    if (!decision.approved) {
      return { tool: this.name, args, tier, exit_code: 1, stdout: '', stderr: decision.reason, duration_ms: Date.now() - start };
    }

    try {
      const result = await this.ctx.bypassShell.exec(command, {});
      this.ctx.auditLog.write({ timestamp: ISO(), level: 'info', service: 'ToolCatalog', message: 'system:free', action: 'tool.system.free', tier });
      return { tool: this.name, args, tier, exit_code: result.exit_code, stdout: result.stdout, stderr: result.stderr, duration_ms: Date.now() - start };
    } catch (err) {
      return { tool: this.name, args, tier, exit_code: 1, stdout: '', stderr: (err as Error).message, duration_ms: Date.now() - start };
    }
  }
}

// ── system:which ──────────────────────────────────────────────────────────────

export class WhichTool implements ITool {
  readonly name = 'system:which';
  readonly description = 'which <binary> — Locate a binary in PATH (Tier 1)';
  readonly tier: PolicyTier = 1;

  constructor(private readonly ctx: ToolContext) {}

  async execute(args: string[]): Promise<ToolResult> {
    const start = Date.now();
    const [binary] = args;
    if (!binary) {
      return { tool: this.name, args, tier: this.tier, exit_code: 1, stdout: '', stderr: 'system:which requires <binary>', duration_ms: 0 };
    }
    if (!SAFE_BIN_RE.test(binary)) {
      return { tool: this.name, args, tier: this.tier, exit_code: 1, stdout: '', stderr: `Invalid binary name: ${binary}. Only alphanumeric, dot, hyphen, underscore allowed.`, duration_ms: 0 };
    }

    const command = `which ${sq(binary)}`;
    const decision = await this.ctx.firewall.classify('shell.exec', { command });
    const tier = decision.tier;

    if (!decision.approved) {
      return { tool: this.name, args, tier, exit_code: 1, stdout: '', stderr: decision.reason, duration_ms: Date.now() - start };
    }

    try {
      const result = await this.ctx.bypassShell.exec(command, {});
      this.ctx.auditLog.write({ timestamp: ISO(), level: 'info', service: 'ToolCatalog', message: `system:which ${binary}`, action: 'tool.system.which', tier });
      return { tool: this.name, args, tier, exit_code: result.exit_code, stdout: result.stdout, stderr: result.stderr, duration_ms: Date.now() - start };
    } catch (err) {
      return { tool: this.name, args, tier, exit_code: 1, stdout: '', stderr: (err as Error).message, duration_ms: Date.now() - start };
    }
  }
}
