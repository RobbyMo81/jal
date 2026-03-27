// Co-authored by FORGE (Session: forge-20260327063704-3049883)
// src/apex/tools/NetworkTools.ts — JAL-012 Network tool implementations
//
// Tools: network:ping, network:port-check, network:curl
//
// Safety gates:
//  - curl restricted to GET — no POST/PUT/DELETE in Phase 2
//  - All tools are Tier 1 (read-only network ops)
//  - URL validated to http(s) scheme only
//  - Host validated (no shell metacharacters)
//  - All invocations audit-logged

import { PolicyTier, ITool, ToolResult } from '../types';
import type { ToolContext } from './ToolRegistry';

const ISO = () => new Date().toISOString();

/** Simple host/domain validation: allow alphanumeric, dot, hyphen, underscore. No shell metacharacters. */
const SAFE_HOST_RE = /^[a-zA-Z0-9._-]+$/;

/** Valid URL scheme for curl. */
const VALID_URL_RE = /^https?:\/\//i;

function sq(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

// ── network:ping ──────────────────────────────────────────────────────────────

export class PingTool implements ITool {
  readonly name = 'network:ping';
  readonly description = 'ping <host> — Send 4 ICMP pings to host (Tier 1)';
  readonly tier: PolicyTier = 1;

  constructor(private readonly ctx: ToolContext) {}

  async execute(args: string[]): Promise<ToolResult> {
    const start = Date.now();
    const [host] = args;
    if (!host) {
      return this.err(args, 'network:ping requires <host>');
    }
    if (!SAFE_HOST_RE.test(host)) {
      return this.err(args, `Invalid host: ${host}. Only alphanumeric, dot, hyphen, underscore allowed.`);
    }

    const command = `ping -c 4 ${sq(host)}`;
    const decision = await this.ctx.firewall.classify('shell.exec', { command });
    const tier = decision.tier;

    if (!decision.approved) {
      return { tool: this.name, args, tier, exit_code: 1, stdout: '', stderr: decision.reason, duration_ms: Date.now() - start };
    }

    try {
      const result = await this.ctx.bypassShell.exec(command, { timeout_ms: 30_000 });
      this.log('info', `network:ping ${host}`, tier, args);
      return { tool: this.name, args, tier, exit_code: result.exit_code, stdout: result.stdout, stderr: result.stderr, duration_ms: Date.now() - start };
    } catch (err) {
      return { tool: this.name, args, tier, exit_code: 1, stdout: '', stderr: (err as Error).message, duration_ms: Date.now() - start };
    }
  }

  private err(args: string[], stderr: string): ToolResult {
    return { tool: this.name, args, tier: this.tier, exit_code: 1, stdout: '', stderr, duration_ms: 0 };
  }

  private log(level: 'info' | 'warn', message: string, tier: PolicyTier, args: string[]): void {
    this.ctx.auditLog.write({ timestamp: ISO(), level, service: 'ToolCatalog', message, action: 'tool.network.ping', tier, tool_args: args });
  }
}

// ── network:port-check ────────────────────────────────────────────────────────

export class PortCheckTool implements ITool {
  readonly name = 'network:port-check';
  readonly description = 'port-check <host> <port> — Check if a TCP port is open (Tier 1)';
  readonly tier: PolicyTier = 1;

  constructor(private readonly ctx: ToolContext) {}

  async execute(args: string[]): Promise<ToolResult> {
    const start = Date.now();
    const [host, portStr] = args;
    if (!host || !portStr) {
      return this.err(args, 'network:port-check requires <host> <port>');
    }
    if (!SAFE_HOST_RE.test(host)) {
      return this.err(args, `Invalid host: ${host}`);
    }
    const port = parseInt(portStr, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      return this.err(args, `Invalid port: ${portStr}. Must be 1–65535.`);
    }

    // nc -zv <host> <port> with 5s timeout
    const command = `nc -zv -w 5 ${sq(host)} ${port}`;
    const decision = await this.ctx.firewall.classify('shell.exec', { command });
    const tier = decision.tier;

    if (!decision.approved) {
      return { tool: this.name, args, tier, exit_code: 1, stdout: '', stderr: decision.reason, duration_ms: Date.now() - start };
    }

    try {
      const result = await this.ctx.bypassShell.exec(command, { timeout_ms: 15_000 });
      this.log('info', `network:port-check ${host}:${port}`, tier, args);
      return { tool: this.name, args, tier, exit_code: result.exit_code, stdout: result.stdout, stderr: result.stderr, duration_ms: Date.now() - start };
    } catch (err) {
      return { tool: this.name, args, tier, exit_code: 1, stdout: '', stderr: (err as Error).message, duration_ms: Date.now() - start };
    }
  }

  private err(args: string[], stderr: string): ToolResult {
    return { tool: this.name, args, tier: this.tier, exit_code: 1, stdout: '', stderr, duration_ms: 0 };
  }

  private log(level: 'info' | 'warn', message: string, tier: PolicyTier, args: string[]): void {
    this.ctx.auditLog.write({ timestamp: ISO(), level, service: 'ToolCatalog', message, action: 'tool.network.port-check', tier, tool_args: args });
  }
}

// ── network:curl ──────────────────────────────────────────────────────────────

export class CurlTool implements ITool {
  readonly name = 'network:curl';
  readonly description = 'curl <url> — HTTP GET request to URL (Tier 1, GET only)';
  readonly tier: PolicyTier = 1;

  constructor(private readonly ctx: ToolContext) {}

  async execute(args: string[]): Promise<ToolResult> {
    const start = Date.now();
    const [url] = args;
    if (!url) {
      return this.err(args, 'network:curl requires <url>');
    }

    // SAFETY GATE: GET only — validate URL scheme and reject non-GET indicators
    if (!VALID_URL_RE.test(url)) {
      return this.err(args, `network:curl only supports http/https URLs. Got: ${url}`);
    }

    // -s silent, -S show errors, -L follow redirects, --max-time 30s, GET only (no -X POST etc.)
    const command = `curl -sS -L --max-time 30 --get ${sq(url)}`;
    const decision = await this.ctx.firewall.classify('shell.exec', { command });
    const tier = decision.tier;

    if (!decision.approved) {
      return { tool: this.name, args, tier, exit_code: 1, stdout: '', stderr: decision.reason, duration_ms: Date.now() - start };
    }

    try {
      const result = await this.ctx.bypassShell.exec(command, { timeout_ms: 35_000 });
      this.log('info', `network:curl ${url}`, tier, args);
      return { tool: this.name, args, tier, exit_code: result.exit_code, stdout: result.stdout, stderr: result.stderr, duration_ms: Date.now() - start };
    } catch (err) {
      return { tool: this.name, args, tier, exit_code: 1, stdout: '', stderr: (err as Error).message, duration_ms: Date.now() - start };
    }
  }

  private err(args: string[], stderr: string): ToolResult {
    return { tool: this.name, args, tier: this.tier, exit_code: 1, stdout: '', stderr, duration_ms: 0 };
  }

  private log(level: 'info' | 'warn', message: string, tier: PolicyTier, args: string[]): void {
    this.ctx.auditLog.write({ timestamp: ISO(), level, service: 'ToolCatalog', message, action: 'tool.network.curl', tier, tool_args: args });
  }
}
