// src/apex/mcp/ApexMCPServer.ts — JAL-029 MCP Observability Server
//
// Exposes JAL's observability layer as an MCP server so AI agents
// (including Claude Code) can query live agent state, audit trails,
// Guardian interventions, and environment snapshots via structured tools.
//
// Transport: stdio (Claude Code spawns this as a subprocess via .mcp.json)
// Safety: all tool responses redact credential-pattern values before returning.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { JALBrain } from '../brain/JALBrain';
import type { Domain } from '../guardian_angle/types';
import { AuditLog } from '../policy/AuditLog';
import type { InterventionLogger } from '../guardian_angle/InterventionLogger';
import type { EpisodicStore } from '../memory/EpisodicStore';
import { SnapshotCollector } from '../heartbeat/EnvironmentSnapshot';
import { ExecSyncShell } from '../heartbeat/HealthChecks';

// ── Credential redaction ──────────────────────────────────────────────────────

const CREDENTIAL_KEYS = /token|key|password|secret|api_key|auth|credential/i;

function redactObj(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(redactObj);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    out[k] = CREDENTIAL_KEYS.test(k) ? '[redacted]' : redactObj(v);
  }
  return out;
}

function safeJson(val: unknown): string {
  return JSON.stringify(redactObj(val), null, 2);
}

// ── ApexMCPServer ─────────────────────────────────────────────────────────────

export interface ApexMCPServerOptions {
  jalBrain: JALBrain;
  auditLog: AuditLog;
  interventionLogger: InterventionLogger;
  episodicStore: EpisodicStore;
  getGuardianSleepStats?: () => Record<string, unknown>;
  /** Override snapshot collector for testing. */
  snapshotCollector?: SnapshotCollector;
}

export class ApexMCPServer {
  private readonly mcp: McpServer;
  private transport: StdioServerTransport | null = null;

  constructor(private readonly opts: ApexMCPServerOptions) {
    this.mcp = new McpServer({
      name: 'apex-observability',
      version: '1.0.0',
    });
    this.registerTools();
  }

  private registerTools(): void {
    const { jalBrain, auditLog, interventionLogger, episodicStore } = this.opts;
    const collector = this.opts.snapshotCollector ?? new SnapshotCollector(new ExecSyncShell());

    // ── get_agent_status ─────────────────────────────────────────────────────
    this.mcp.tool(
      'get_agent_status',
      'Returns the current JAL working memory: active goal, provider, model, session count.',
      async () => ({
        content: [{ type: 'text' as const, text: safeJson(jalBrain.getMemory()) }],
      }),
    );

    // ── query_audit_log ──────────────────────────────────────────────────────
    this.mcp.tool(
      'query_audit_log',
      'Query the JAL audit log. Returns up to 100 entries (newest first), filtered by optional level, action, and since (ISO timestamp).',
      {
        level: z.string().optional().describe('Filter by log level (info, warn, error)'),
        action: z.string().optional().describe('Filter by action string (e.g. shell.exec)'),
        since: z.string().optional().describe('ISO timestamp — return entries after this time'),
        limit: z.number().int().min(1).max(100).optional().describe('Max entries to return (default 100)'),
      },
      async (args) => {
        const entries = auditLog.query({
          level: args.level,
          action: args.action,
          since: args.since,
          limit: args.limit,
        });
        return { content: [{ type: 'text' as const, text: safeJson(entries) }] };
      },
    );

    // ── get_guardian_interventions ───────────────────────────────────────────
    this.mcp.tool(
      'get_guardian_interventions',
      'Returns Guardian DVU correction records: student_draft, corrected_output, domain, entropy_score, pof_index.',
      {
        domain: z.string().optional().describe('Filter by domain (reasoning, code_generation, shell_commands, general, math, factual)'),
        since: z.string().optional().describe('ISO timestamp — return records after this time'),
        limit: z.number().int().min(1).max(100).optional().describe('Max records to return (default 20)'),
      },
      async (args) => {
        const records = interventionLogger.query({
          domain: args.domain as Domain | undefined,
          since: args.since,
          limit: args.limit ?? 20,
        });
        return { content: [{ type: 'text' as const, text: safeJson(records) }] };
      },
    );

    // ── get_environment_snapshot ─────────────────────────────────────────────
    this.mcp.tool(
      'get_environment_snapshot',
      'Returns the current environment snapshot: running processes (names only), disk mounts, available memory, container states.',
      async () => {
        const snapshot = collector.collect();
        // Strip process command lines — return names only for safety
        const safe = {
          ...snapshot,
          processes: snapshot.processes.map(p => ({
            pid: p.pid,
            name: p.name,
            cpu_percent: p.cpu_percent,
            mem_percent: p.mem_percent,
          })),
        };
        return { content: [{ type: 'text' as const, text: safeJson(safe) }] };
      },
    );

    // ── get_task_history ─────────────────────────────────────────────────────
    this.mcp.tool(
      'get_task_history',
      'Returns recent GoalLoop execution traces from episodic memory.',
      {
        limit: z.number().int().min(1).max(50).optional().describe('Max entries to return (default 10)'),
      },
      async (args) => {
        const all = episodicStore.list('apex_goal_loop');
        const items = all.slice(-(args.limit ?? 10)).reverse();
        return { content: [{ type: 'text' as const, text: safeJson(items) }] };
      },
    );

    // ── get_sleep_stats ──────────────────────────────────────────────────────
    this.mcp.tool(
      'get_sleep_stats',
      'Returns GuardianAngle per-domain sleep mode status (accuracy, window, in_sleep_mode).',
      async () => {
        const stats = this.opts.getGuardianSleepStats?.() ?? {};
        return { content: [{ type: 'text' as const, text: safeJson(stats) }] };
      },
    );
  }

  async start(): Promise<void> {
    this.transport = new StdioServerTransport();
    await this.mcp.connect(this.transport);
  }

  async stop(): Promise<void> {
    await this.mcp.close();
  }
}
