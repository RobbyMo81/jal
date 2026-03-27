// Co-authored by FORGE (Session: forge-20260327063704-3049883)
// src/apex/plugins/PluginCoordinator.ts — JAL-016 Plugin Coordinator
//
// Runs as a local service inside ApexRuntime. Responsibilities:
//   - Per-workspace message queues at ~/.apex/state/plugin-queues/
//   - Outbound event dispatch to registered plugins (Slack, Telegram)
//   - Inbound action polling from plugins every 10 seconds
//   - Single-use approval token lifecycle (10-minute TTL)
//   - Actor identity mapping via ~/.apex/config/plugin-actors.json
//   - HMAC-SHA256 signing of all outbound events
//   - Redaction: strips code snippets, file paths, env var names
//
// REST routes (handled by CanvasServer):
//   GET  /apex/plugin-actions/:workspace_id
//   POST /apex/plugin-actions/:workspace_id/ack/:action_id
//
// SAFETY GATES:
//   - HMAC signature verified on every inbound action
//   - Unmapped actors always rejected — no fallback
//   - Bot tokens stored in OS keychain only — never in this file

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { homedir } from 'os';
import {
  IPlugin,
  InboundAction,
  PluginActorEntry,
  PluginActorMap,
  PluginApprovalToken,
  PluginEvent,
  CanvasEventType,
  RedactionLevel,
  PolicyTier,
} from '../types';
import { IAuditLog } from '../policy/AuditLog';

// ── Constants ─────────────────────────────────────────────────────────────────

const TOKEN_TTL_MS = 10 * 60 * 1000; // 10 minutes
const POLL_INTERVAL_MS = 10_000;      // 10 seconds
const QUEUE_DIR_DEFAULT = path.join(homedir(), '.apex', 'state', 'plugin-queues');
const ACTOR_MAP_DEFAULT = path.join(homedir(), '.apex', 'config', 'plugin-actors.json');

// ── Redaction ─────────────────────────────────────────────────────────────────

/** Regex patterns used by the standard redaction level. */
const REDACT_PATTERNS = {
  /** Absolute-looking file paths (Unix and Windows) */
  file_path: /(?:\/[\w.-]+)+|(?:[A-Za-z]:\\[\w\\.-]+)/g,
  /** Env var references like $VAR or ${VAR} */
  env_var: /\$\{?[A-Z_][A-Z0-9_]*\}?/g,
  /** Fenced code blocks */
  code_block: /```[\s\S]*?```/g,
  /** Inline code */
  inline_code: /`[^`\n]+`/g,
};

/**
 * Apply the standard redaction level to a string value.
 * Removes code snippets, file paths, and env var names.
 */
function redactString(value: string): string {
  return value
    .replace(REDACT_PATTERNS.code_block, '[redacted:code]')
    .replace(REDACT_PATTERNS.inline_code, '[redacted:code]')
    .replace(REDACT_PATTERNS.file_path, '[redacted:path]')
    .replace(REDACT_PATTERNS.env_var, '[redacted:env]');
}

/**
 * Recursively redact string fields in a payload object.
 * Non-string leaves are passed through unchanged.
 */
function redactPayload(
  payload: Record<string, unknown>,
  level: RedactionLevel,
): Record<string, unknown> {
  if (level === 'none') return payload;

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(payload)) {
    if (level === 'full') {
      // Full: only keep structural keys, replace all values
      out[key] = '[redacted]';
    } else {
      // Standard: recurse into objects, redact strings
      if (typeof val === 'string') {
        out[key] = redactString(val);
      } else if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
        out[key] = redactPayload(val as Record<string, unknown>, level);
      } else {
        out[key] = val;
      }
    }
  }
  return out;
}

// ── PluginCoordinator ─────────────────────────────────────────────────────────

export interface PluginCoordinatorOptions {
  queueDir?: string;
  actorMapPath?: string;
  hmacSecret?: string;
  auditLog?: IAuditLog;
}

export class PluginCoordinator {
  private readonly queueDir: string;
  private readonly actorMapPath: string;
  /** HMAC secret for signing outbound events and verifying inbound ones. */
  private readonly hmacSecret: string;
  private readonly auditLog: IAuditLog | null;

  /** Registered plugins. */
  private readonly plugins = new Map<string, IPlugin>();
  /** Per-workspace inbound action queues (workspace_id → actions). */
  private readonly actionQueues = new Map<string, InboundAction[]>();
  /** Active single-use approval tokens. */
  private readonly approvalTokens = new Map<string, PluginApprovalToken>();

  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: PluginCoordinatorOptions = {}) {
    this.queueDir = options.queueDir ?? QUEUE_DIR_DEFAULT;
    this.actorMapPath = options.actorMapPath ?? ACTOR_MAP_DEFAULT;
    // In production the HMAC secret is generated fresh per session and never persisted.
    // Tests may inject a deterministic secret.
    this.hmacSecret = options.hmacSecret ?? crypto.randomBytes(32).toString('hex');
    this.auditLog = options.auditLog ?? null;
    this.ensureQueueDir();
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** Register a plugin adapter. Must be called before start(). */
  register(plugin: IPlugin): void {
    this.plugins.set(plugin.name, plugin);
  }

  /** Start polling all plugins every 10 seconds. */
  start(): void {
    if (this.pollTimer !== null) return;
    this.pollTimer = setInterval(() => void this.pollAll(), POLL_INTERVAL_MS);
  }

  /**
   * Disconnect all plugins: expire in-flight tokens, stop polling,
   * and revert Canvas to HITL-only mode (caller responsibility).
   */
  stop(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const plugin of this.plugins.values()) {
      plugin.disconnect();
    }
    // Expire all in-flight tokens immediately
    const now = new Date().toISOString();
    for (const token of this.approvalTokens.values()) {
      if (!token.used) {
        token.used = true;
        this.audit('warn', 'plugin.token.expired_on_disconnect', {
          token_id: token.token_id,
          approval_id: token.approval_id,
          workspace_id: token.workspace_id,
          expired_at: now,
        });
      }
    }
    this.approvalTokens.clear();
  }

  // ── Outbound: send event to all registered plugins ─────────────────────────

  /**
   * Dispatch an outbound event to all registered plugins.
   * Applies standard redaction, signs the envelope, and queues it for
   * each plugin's send() method.
   */
  async dispatch(
    eventType: CanvasEventType,
    workspaceId: string,
    taskId: string | null,
    tier: PolicyTier | null,
    payload: Record<string, unknown>,
    redactionLevel: RedactionLevel = 'standard',
  ): Promise<void> {
    const event = this.buildEvent(eventType, workspaceId, taskId, tier, payload, redactionLevel);
    const errors: string[] = [];
    for (const plugin of this.plugins.values()) {
      try {
        await plugin.send(event);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${plugin.name}: ${msg}`);
        this.audit('error', 'plugin.send.error', { plugin: plugin.name, error: msg });
      }
    }
    if (errors.length > 0) {
      this.audit('warn', 'plugin.dispatch.partial_failure', { errors });
    }
  }

  // ── Approval token lifecycle ───────────────────────────────────────────────

  /**
   * Issue a single-use approval token bound to workspace_id + approval_id.
   * Returns the token string that must be presented when acknowledging.
   */
  issueToken(workspaceId: string, approvalId: string): PluginApprovalToken {
    const token: PluginApprovalToken = {
      token_id: crypto.randomUUID(),
      approval_id: approvalId,
      workspace_id: workspaceId,
      expires_at: new Date(Date.now() + TOKEN_TTL_MS).toISOString(),
      used: false,
      created_at: new Date().toISOString(),
    };
    this.approvalTokens.set(token.token_id, token);
    this.pruneExpiredTokens();
    return token;
  }

  /**
   * Validate a token:
   *   - Must exist in the active token map
   *   - Must not be used
   *   - Must not be expired
   *   - workspace_id and approval_id must match
   *
   * On success, marks the token as used (single-use).
   * Returns the token record or null if invalid.
   */
  consumeToken(
    tokenId: string,
    workspaceId: string,
    approvalId: string,
  ): PluginApprovalToken | null {
    const token = this.approvalTokens.get(tokenId);
    if (!token) return null;
    if (token.used) return null;
    if (token.workspace_id !== workspaceId) return null;
    if (token.approval_id !== approvalId) return null;
    if (new Date(token.expires_at) <= new Date()) {
      this.approvalTokens.delete(tokenId);
      return null;
    }
    token.used = true;
    return token;
  }

  // ── Inbound action queue (REST) ────────────────────────────────────────────

  /**
   * GET /apex/plugin-actions/:workspace_id
   * Returns pending inbound actions for a workspace and clears the queue.
   */
  dequeueActions(workspaceId: string): InboundAction[] {
    const queue = this.actionQueues.get(workspaceId) ?? [];
    this.actionQueues.delete(workspaceId);
    return queue;
  }

  /**
   * POST /apex/plugin-actions/:workspace_id/ack/:action_id
   * Acknowledges an action: validates HMAC signature, maps actor identity,
   * and returns the resolved apex identity or null if rejected.
   *
   * SAFETY GATES:
   *   - HMAC-SHA256 signature verified before processing
   *   - Unmapped actor always rejected — no fallback
   */
  acknowledgeAction(
    workspaceId: string,
    action: InboundAction,
  ): { success: boolean; apex_identity?: string; error?: string } {
    // Verify HMAC signature (action.signature must match HMAC of all other fields)
    const expectedSig = this.signInbound(action);
    const providedSig = action.signature ?? '';
    // Validate hex encoding and length before timingSafeEqual to avoid RangeError
    const expectedBuf = Buffer.from(expectedSig, 'hex');
    let providedBuf: Buffer;
    try {
      providedBuf = Buffer.from(providedSig, 'hex');
    } catch {
      providedBuf = Buffer.alloc(0);
    }
    const sigValid =
      providedBuf.length === expectedBuf.length &&
      providedBuf.length > 0 &&
      crypto.timingSafeEqual(providedBuf, expectedBuf);
    if (!sigValid) {
      this.audit('warn', 'plugin.action.invalid_signature', {
        action_id: action.action_id,
        workspace_id: workspaceId,
        plugin: action.plugin_name,
        actor: action.actor_platform_id,
      });
      return { success: false, error: 'Invalid signature' };
    }

    // Map actor identity
    const apexIdentity = this.resolveActorIdentity(
      action.plugin_name,
      action.actor_platform_id,
    );
    if (!apexIdentity) {
      this.audit('warn', 'plugin.action.unmapped_actor', {
        action_id: action.action_id,
        workspace_id: workspaceId,
        plugin: action.plugin_name,
        actor: action.actor_platform_id,
      });
      return { success: false, error: 'Unmapped actor — action rejected' };
    }

    // Validate token
    const token = this.consumeToken(action.token, workspaceId, action.approval_id);
    if (!token) {
      this.audit('warn', 'plugin.action.invalid_token', {
        action_id: action.action_id,
        workspace_id: workspaceId,
        approval_id: action.approval_id,
      });
      return { success: false, error: 'Invalid, expired, or already-used token' };
    }

    this.audit('info', 'plugin.action.acknowledged', {
      action_id: action.action_id,
      workspace_id: workspaceId,
      action_type: action.action_type,
      apex_identity: apexIdentity,
      plugin: action.plugin_name,
    });
    return { success: true, apex_identity: apexIdentity };
  }

  // ── HMAC signing ──────────────────────────────────────────────────────────

  /**
   * Sign an outbound PluginEvent.
   * Canonical form: JSON.stringify of the event minus the 'signature' field,
   * keys sorted alphabetically.
   */
  signEvent(event: Omit<PluginEvent, 'signature'>): string {
    const canonical = JSON.stringify(event, Object.keys(event).sort());
    return crypto
      .createHmac('sha256', this.hmacSecret)
      .update(canonical)
      .digest('hex');
  }

  /**
   * Produce the HMAC signature for an inbound action.
   * Used by relay services when constructing InboundAction.signature.
   * Signs all fields except 'signature' itself.
   */
  signInbound(action: Omit<InboundAction, 'signature'> & { signature?: string }): string {
    const { signature: _removed, ...rest } = action as InboundAction;
    const canonical = JSON.stringify(rest, Object.keys(rest).sort());
    return crypto
      .createHmac('sha256', this.hmacSecret)
      .update(canonical)
      .digest('hex');
  }

  // ── Actor identity mapping ─────────────────────────────────────────────────

  /**
   * Resolve a platform actor ID to a local Apex identity.
   * Returns null if no mapping exists — callers must reject.
   */
  resolveActorIdentity(pluginName: string, platformId: string): string | null {
    const map = this.loadActorMap();
    const entry = map.actors.find(
      (a: PluginActorEntry) => a.plugin_name === pluginName && a.platform_id === platformId,
    );
    return entry?.apex_identity ?? null;
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  private buildEvent(
    eventType: CanvasEventType,
    workspaceId: string,
    taskId: string | null,
    tier: PolicyTier | null,
    payload: Record<string, unknown>,
    redactionLevel: RedactionLevel,
  ): PluginEvent {
    const redactedPayload = redactPayload(payload, redactionLevel);
    const eventWithoutSig: Omit<PluginEvent, 'signature'> = {
      event_id: crypto.randomUUID(),
      event_type: eventType,
      workspace_id: workspaceId,
      task_id: taskId,
      tier,
      created_at: new Date().toISOString(),
      payload: redactedPayload,
      redaction_level: redactionLevel,
    };
    const signature = this.signEvent(eventWithoutSig);
    return { ...eventWithoutSig, signature };
  }

  private async pollAll(): Promise<void> {
    for (const plugin of this.plugins.values()) {
      try {
        const actions = await plugin.poll();
        for (const action of actions) {
          const queue = this.actionQueues.get(action.workspace_id) ?? [];
          queue.push(action);
          this.actionQueues.set(action.workspace_id, queue);
          this.persistAction(action);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.audit('error', 'plugin.poll.error', { plugin: plugin.name, error: msg });
      }
    }
  }

  private persistAction(action: InboundAction): void {
    const wsDir = path.join(this.queueDir, action.workspace_id);
    fs.mkdirSync(wsDir, { recursive: true });
    const file = path.join(wsDir, `${action.action_id}.json`);
    fs.writeFileSync(file, JSON.stringify(action, null, 2), 'utf-8');
  }

  private ensureQueueDir(): void {
    fs.mkdirSync(this.queueDir, { recursive: true });
  }

  private pruneExpiredTokens(): void {
    const now = new Date();
    for (const [id, token] of this.approvalTokens.entries()) {
      if (new Date(token.expires_at) <= now) {
        this.approvalTokens.delete(id);
      }
    }
  }

  private loadActorMap(): PluginActorMap {
    try {
      if (!fs.existsSync(this.actorMapPath)) {
        return { version: 1, actors: [] };
      }
      const raw = fs.readFileSync(this.actorMapPath, 'utf-8');
      return JSON.parse(raw) as PluginActorMap;
    } catch {
      return { version: 1, actors: [] };
    }
  }

  private audit(
    level: 'info' | 'warn' | 'error',
    action: string,
    meta: Record<string, unknown>,
  ): void {
    this.auditLog?.write({
      timestamp: new Date().toISOString(),
      level,
      service: 'PluginCoordinator',
      action,
      message: action,
      ...meta,
    });
  }
}
