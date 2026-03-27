// Co-authored by FORGE (Session: forge-20260327063704-3049883)
// src/apex/tools/ToolRegistry.ts — JAL-012 Expanded Tool Catalog
//
// Central registry for all Apex built-in tools.
// ToolRegistry.catalog() produces a formatted string injected into the GoalLoop
// LLM prompt so the model knows exactly what primitives are available.
//
// Usage:
//   const registry = new ToolRegistry();
//   registry.register(new ReadFileTool(ctx));
//   const tool = registry.get('file:read');
//   const result = await tool.execute(['/tmp/foo.txt']);
//   const catalog = registry.catalog(); // inject into LLM prompt

import { ITool, ToolResult } from '../types';
export { ITool, ToolResult };

// ── ToolContext ────────────────────────────────────────────────────────────────

/**
 * Dependencies injected into every tool at construction time.
 * Tools use these to delegate execution — they never spawn processes directly.
 */
export interface ToolContext {
  /** ShellEngine without a firewall guard — tools pre-classify themselves. */
  bypassShell: import('../shell/ShellEngine').ShellEngine;
  /** PolicyFileOps for file read/write operations (includes path & tier enforcement). */
  fileOps: import('../fileops/PolicyFileOps').PolicyFileOps;
  /** Audit log for tool invocation records. */
  auditLog: import('../policy/AuditLog').IAuditLog;
  /**
   * TieredFirewall for pre-classification of shell commands.
   * classify() must be called before every shell dispatch.
   */
  firewall: import('../policy/TieredFirewall').TieredFirewall;
}

// ── ToolRegistry ──────────────────────────────────────────────────────────────

export class ToolRegistry {
  private readonly tools = new Map<string, ITool>();

  /** Register a tool. Overwrites any existing tool with the same name. */
  register(tool: ITool): void {
    this.tools.set(tool.name, tool);
  }

  /** Look up a tool by name. Returns undefined if not registered. */
  get(name: string): ITool | undefined {
    return this.tools.get(name);
  }

  /** All registered tools, sorted by name. */
  list(): ITool[] {
    return [...this.tools.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Produce a formatted catalog string for injection into LLM prompts.
   * Each line: `  - <name> <args_hint>: <description> [Tier <n>]`
   */
  catalog(): string {
    const lines = this.list().map((t) => `  - ${t.name}: ${t.description} [Tier ${t.tier}]`);
    return lines.length > 0
      ? `Available tools:\n${lines.join('\n')}`
      : 'Available tools: (none registered)';
  }
}
