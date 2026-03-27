// Co-authored by FORGE (Session: forge-20260326221916-3025550)
// src/apex/runtime/ApexRuntime.ts — JAL-009 + JAL-010 Unified Phase 1 Runtime Wiring
//
// JAL-009: instantiates and wires all Phase 1 services.
// JAL-010: loads Soul.md and Behavior.md into working memory at start();
//          reads heartbeat_narrative from durable context for session start ambient status.
//
// Lifecycle:
//   start()  — ensure ~/.apex/ dirs exist, load identity docs, start heartbeat,
//               read heartbeat_narrative, write startup audit entry
//   stop()   — stop heartbeat, cancel active shell procs, write shutdown audit entry

import { mkdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { ShellEngine } from '../shell/ShellEngine';
import { DockerEngine } from '../docker/DockerEngine';
import { TieredFirewall } from '../policy/TieredFirewall';
import { ApprovalService } from '../policy/ApprovalService';
import { AuditLog, IAuditLog } from '../policy/AuditLog';
import { PackageAllowlist } from '../policy/PackageAllowlist';
import { PolicyFileOps } from '../fileops/PolicyFileOps';
import { WorkspaceRootsConfig } from '../fileops/WorkspaceRootsConfig';
import { AuthManager } from '../auth/AuthManager';
import { IKeychain } from '../auth/IKeychain';
import { MemoryKeychain } from '../auth/MemoryKeychain';
import { ProviderGateway, StubProviderAdapter } from '../auth/ProviderGateway';
import { HeartbeatScheduler } from '../heartbeat/HeartbeatScheduler';
import { CheckpointStore } from '../checkpoint/CheckpointStore';
import { MemoryManager } from '../memory/MemoryManager';
import { EpisodicStore } from '../memory/EpisodicStore';
import { DurableStore } from '../memory/DurableStore';
import { ApprovalToken } from '../types';
import { ToolRegistry } from '../tools/ToolRegistry';
import { ReadFileTool, WriteFileTool, ListDirTool, SearchFilesTool, DiffFilesTool } from '../tools/FileTools';
import { PsTool, KillTool, TopNTool } from '../tools/ProcessTools';
import { PingTool, PortCheckTool, CurlTool } from '../tools/NetworkTools';
import { TailTool, LogGrepTool } from '../tools/LogTools';
import { EnvTool, UptimeTool, DfTool, FreeTool, WhichTool } from '../tools/SystemTools';

// ── Constants ──────────────────────────────────────────────────────────────────

const IDENTITY_DOCS = ['Soul.md', 'Behavior.md'] as const;
const HEARTBEAT_NARRATIVE_ID = 'heartbeat_narrative';
const APEX_SRC_DIR = join(__dirname, '..');

// ── ApexRuntimeOptions ─────────────────────────────────────────────────────────

export interface ApexRuntimeOptions {
  /** Called when a Tier 2 action requires operator approval (wired to REPL stdin). */
  onApprovalRequired?: (token: ApprovalToken) => void;
  /** Override keychain implementation. Defaults to MemoryKeychain (Phase 1 only). */
  keychain?: IKeychain;
  /** Override audit log. Defaults to filesystem AuditLog. */
  auditLog?: IAuditLog;
  /**
   * Override the ~/.apex/state root for testing.
   * Defaults to os.homedir()/.apex/state.
   */
  stateDir?: string;
  /**
   * Override the directory to load Soul.md and Behavior.md from.
   * Defaults to src/apex/ (resolved via __dirname).
   */
  identityDocsDir?: string;
  /**
   * Inject a pre-configured ProviderGateway for GoalLoop (JAL-011).
   * If not provided, a stub gateway is created with StubProviderAdapter
   * and a Phase 1 stub token (for dev/test only).
   */
  providerGateway?: ProviderGateway;
}

// ── ApexRuntime ────────────────────────────────────────────────────────────────

export class ApexRuntime {
  readonly version = '1.0.0';

  // All services are public so the REPL and tests can access them directly.
  readonly auditLog: IAuditLog;
  readonly approvalService: ApprovalService;
  readonly allowlist: PackageAllowlist;
  readonly firewall: TieredFirewall;
  readonly shellEngine: ShellEngine;
  readonly dockerEngine: DockerEngine;
  readonly fileOps: PolicyFileOps;
  readonly authManager: AuthManager;
  readonly heartbeat: HeartbeatScheduler;
  readonly checkpointStore: CheckpointStore;
  readonly memoryManager: MemoryManager;
  /** Provider-agnostic LLM gateway for GoalLoop (JAL-011). */
  readonly providerGateway: ProviderGateway;
  /** Tool catalog for GoalLoop context injection and direct tool dispatch (JAL-012). */
  readonly toolRegistry: ToolRegistry;

  private readonly apexHome: string;
  private readonly identityDocsDir: string;
  private readonly durableStore: DurableStore;
  /** True when a stub ProviderGateway was auto-created (no real gateway injected). */
  private readonly isStubGateway: boolean;

  /**
   * Identity documents loaded at session start.
   * Soul.md → 'soul', Behavior.md → 'behavior'.
   * Null if the file was absent (non-fatal, warning is logged).
   */
  readonly identityDocs: Record<'soul' | 'behavior', string | null> = {
    soul: null,
    behavior: null,
  };

  /**
   * Latest heartbeat narrative from durable context.
   * Populated by start(). Null if no narrative has been written yet.
   */
  heartbeatNarrative: string | null = null;

  constructor(options: ApexRuntimeOptions = {}) {
    this.apexHome = join(homedir(), '.apex');
    this.identityDocsDir = options.identityDocsDir ?? APEX_SRC_DIR;

    // Core audit + approval infrastructure
    this.auditLog = options.auditLog ?? new AuditLog();
    this.approvalService = new ApprovalService();
    this.allowlist = new PackageAllowlist(this.auditLog);

    // Policy firewall — wires onApprovalRequired so REPL can intercept Tier 2
    this.firewall = new TieredFirewall(
      this.approvalService,
      this.auditLog,
      this.allowlist,
      options.onApprovalRequired
    );

    // Execution engines — both use the same firewall instance
    this.shellEngine = new ShellEngine(this.firewall);
    this.dockerEngine = new DockerEngine(this.firewall);

    // File operations — also uses the firewall approval callback
    const workspaceRoots = new WorkspaceRootsConfig(this.auditLog);
    this.fileOps = new PolicyFileOps(
      workspaceRoots,
      this.approvalService,
      this.auditLog,
      options.onApprovalRequired
    );

    // Auth — uses injected or in-memory keychain (Phase 2 will swap in SecretToolKeychain)
    const keychain: IKeychain = options.keychain ?? new MemoryKeychain();
    this.authManager = new AuthManager({ keychain, audit: this.auditLog });

    // Memory stores — shared between MemoryManager and HeartbeatScheduler
    const episodicStore = new EpisodicStore(options.stateDir);
    this.durableStore = new DurableStore(options.stateDir);

    // Heartbeat — wired with memory stores for delta observation writes
    this.heartbeat = new HeartbeatScheduler({
      auditLog: this.auditLog,
      episodicStore,
      durableStore: this.durableStore,
    });

    this.checkpointStore = new CheckpointStore(options.stateDir);
    this.memoryManager = new MemoryManager(options.stateDir);

    // Provider gateway — injected or stub for Phase 1
    if (options.providerGateway) {
      this.providerGateway = options.providerGateway;
      this.isStubGateway = false;
    } else {
      this.providerGateway = new ProviderGateway({
        authManager: this.authManager,
        config: { provider: 'stub', model: 'stub-model' },
      });
      this.providerGateway.registerAdapter(
        new StubProviderAdapter('stub', '[stub response]')
      );
      this.isStubGateway = true;
    }

    // Tool registry — bypass ShellEngine (no firewall) + firewall for pre-classification
    const bypassShell = new ShellEngine(); // no firewall — tools classify themselves
    const toolCtx = {
      bypassShell,
      fileOps: this.fileOps,
      auditLog: this.auditLog,
      firewall: this.firewall,
    };
    this.toolRegistry = new ToolRegistry();
    // File tools
    this.toolRegistry.register(new ReadFileTool(toolCtx));
    this.toolRegistry.register(new WriteFileTool(toolCtx));
    this.toolRegistry.register(new ListDirTool(toolCtx));
    this.toolRegistry.register(new SearchFilesTool(toolCtx));
    this.toolRegistry.register(new DiffFilesTool(toolCtx));
    // Process tools
    this.toolRegistry.register(new PsTool(toolCtx));
    this.toolRegistry.register(new KillTool(toolCtx));
    this.toolRegistry.register(new TopNTool(toolCtx));
    // Network tools
    this.toolRegistry.register(new PingTool(toolCtx));
    this.toolRegistry.register(new PortCheckTool(toolCtx));
    this.toolRegistry.register(new CurlTool(toolCtx));
    // Log tools
    this.toolRegistry.register(new TailTool(toolCtx));
    this.toolRegistry.register(new LogGrepTool(toolCtx));
    // System tools
    this.toolRegistry.register(new EnvTool(toolCtx));
    this.toolRegistry.register(new UptimeTool(toolCtx));
    this.toolRegistry.register(new DfTool(toolCtx));
    this.toolRegistry.register(new FreeTool(toolCtx));
    this.toolRegistry.register(new WhichTool(toolCtx));
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────────

  /**
   * Start the runtime:
   *   1. Ensure all ~/.apex/ subdirectories exist (creates if missing).
   *   2. Load Soul.md and Behavior.md into working memory.
   *   3. Read the latest heartbeat_narrative from durable context.
   *   4. Start the heartbeat scheduler.
   *   5. Write a startup audit entry.
   */
  async start(): Promise<void> {
    this.ensureApexDirs();
    this.loadIdentityDocs();
    this.loadHeartbeatNarrative();
    // Stub provider auto-login for Phase 1 (only when no real gateway was injected)
    if (this.isStubGateway) {
      await this.authManager.login('stub', 'stub-token-phase1', {
        auth_method: 'cli-hook',
        expires_at: null,
      });
    }

    this.heartbeat.start();
    this.auditLog.write({
      timestamp: new Date().toISOString(),
      level: 'info',
      service: 'ApexRuntime',
      message: `ApexRuntime v${this.version} started`,
      action: 'runtime.start',
      heartbeat_interval_sec: this.heartbeat.intervalSeconds,
      identity_docs_loaded: Object.entries(this.identityDocs)
        .filter(([, v]) => v !== null)
        .map(([k]) => k),
    });
  }

  /**
   * Stop the runtime gracefully:
   *   1. Stop the heartbeat scheduler (clears setInterval).
   *   2. Cancel all active shell executions (sends SIGTERM).
   *   3. Write a shutdown audit entry.
   *
   * Docker operations are fire-and-forget at this layer — the REPL loop
   * should drain them before calling stop().
   */
  async stop(): Promise<void> {
    this.heartbeat.stop();

    for (const [execId] of this.shellEngine.getActiveExecutions()) {
      this.shellEngine.cancel(execId);
    }

    this.auditLog.write({
      timestamp: new Date().toISOString(),
      level: 'info',
      service: 'ApexRuntime',
      message: `ApexRuntime v${this.version} stopped`,
      action: 'runtime.stop',
    });
  }

  get heartbeatIntervalSeconds(): number {
    return this.heartbeat.intervalSeconds;
  }

  // ── Private ───────────────────────────────────────────────────────────────────

  /**
   * Load Soul.md and Behavior.md from identityDocsDir into working memory.
   * Missing files produce a warning and are stored as null — they are identity
   * documents, not hard dependencies.
   */
  private loadIdentityDocs(): void {
    const docMap: Array<[string, 'soul' | 'behavior']> = IDENTITY_DOCS.map((name) => {
      const key = name.toLowerCase().replace('.md', '') as 'soul' | 'behavior';
      return [name, key];
    });

    for (const [filename, key] of docMap) {
      const filePath = join(this.identityDocsDir, filename);
      if (!existsSync(filePath)) {
        this.auditLog.write({
          timestamp: new Date().toISOString(),
          level: 'warn',
          service: 'ApexRuntime',
          message: `Identity document not found: ${filename} (continuing without it)`,
          action: 'runtime.identity_doc_missing',
          file: filePath,
        });
        this.identityDocs[key] = null;
        continue;
      }
      try {
        const content = readFileSync(filePath, 'utf8');
        this.identityDocs[key] = content;
        // Store in short-term memory as the agent's active identity layer
        this.memoryManager.addShortTerm(
          content,
          ['identity', key, 'session-start'],
          'apex_system',
          'runtime',
        );
        this.auditLog.write({
          timestamp: new Date().toISOString(),
          level: 'info',
          service: 'ApexRuntime',
          message: `Identity document loaded: ${filename}`,
          action: 'runtime.identity_doc_loaded',
          file: filePath,
          bytes: Buffer.byteLength(content, 'utf8'),
        });
      } catch (e) {
        this.auditLog.write({
          timestamp: new Date().toISOString(),
          level: 'warn',
          service: 'ApexRuntime',
          message: `Failed to read identity document ${filename}: ${(e as Error).message}`,
          action: 'runtime.identity_doc_error',
          file: filePath,
        });
        this.identityDocs[key] = null;
      }
    }
  }

  /** Read the latest heartbeat_narrative from durable context into this.heartbeatNarrative. */
  private loadHeartbeatNarrative(): void {
    try {
      const item = this.durableStore.get(HEARTBEAT_NARRATIVE_ID);
      this.heartbeatNarrative = item?.content ?? null;
      if (this.heartbeatNarrative) {
        this.auditLog.write({
          timestamp: new Date().toISOString(),
          level: 'info',
          service: 'ApexRuntime',
          message: 'Heartbeat narrative loaded from durable context',
          action: 'runtime.narrative_loaded',
        });
      }
    } catch {
      // Non-fatal — narrative simply won't be shown at session start
      this.heartbeatNarrative = null;
    }
  }

  private ensureApexDirs(): void {
    const dirs = [
      join(this.apexHome, 'audit'),
      join(this.apexHome, 'policy'),
      join(this.apexHome, 'policy', 'playbooks'),
      join(this.apexHome, 'policy', 'prompts'),
      join(this.apexHome, 'state', 'checkpoints'),
      join(this.apexHome, 'state', 'outputs'),
      join(this.apexHome, 'state', 'memory'),
      join(this.apexHome, 'config'),
    ];
    for (const d of dirs) {
      mkdirSync(d, { recursive: true });
    }
  }
}
