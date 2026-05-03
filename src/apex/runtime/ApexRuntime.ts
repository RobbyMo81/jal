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
import { randomBytes } from 'crypto';
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
import { MemoryKeychain } from '../auth/MemoryKeychain'; // kept for test injection via options.keychain
import { ProviderGateway, StubProviderAdapter } from '../auth/ProviderGateway';
import { OllamaAdapter } from '../auth/OllamaAdapter';
import { ClaudeAdapter } from '../auth/ClaudeAdapter';
import { GeminiAdapter } from '../auth/GeminiAdapter';
import { OpenAIAdapter } from '../auth/OpenAIAdapter';
import { FallbackProviderChain } from '../providers/FallbackProviderChain';
import { GuardianAngle } from '../guardian_angle/GuardianAngle';
import { JALBrain } from '../brain/JALBrain';
import { GuardianBrain } from '../brain/GuardianBrain';
import { createKeychain } from '../auth/KeychainFactory';
import { HeartbeatScheduler } from '../heartbeat/HeartbeatScheduler';
import { CheckpointStore } from '../checkpoint/CheckpointStore';
import { MemoryManager } from '../memory/MemoryManager';
import { EpisodicStore } from '../memory/EpisodicStore';
import { DurableStore } from '../memory/DurableStore';
import { ApprovalToken } from '../types';
import { ToolRegistry } from '../tools/ToolRegistry';
import { EventBus } from '../canvas/EventBus';
import { CanvasServer, CanvasServerOptions, makeCanvasEvent } from '../canvas/CanvasServer';
import { SnapshotCollector } from '../heartbeat/EnvironmentSnapshot';
import { ExecSyncShell } from '../heartbeat/HealthChecks';
import { PluginCoordinator } from '../plugins/PluginCoordinator';
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
  /** Override keychain implementation. Defaults to KeychainFactory auto-selection. */
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
  /**
   * Canvas server options (JAL-013).
   * Set to false to disable the Canvas server entirely (e.g. in tests).
   */
  canvas?: CanvasServerOptions | false;
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
  /** Event bus for Canvas events (JAL-013). ApexRuntime publishes; CanvasServer subscribes. */
  readonly eventBus: EventBus;
  /**
   * Session token for Canvas WebSocket auth (JAL-013).
   * Generated at start() and printed to the REPL banner.
   * Null before start() is called.
   */
  sessionToken: string | null = null;
  /** Canvas WebSocket + REST server (JAL-013). Null if canvas was disabled in options. */
  readonly canvasServer: CanvasServer | null;
  /**
   * Plugin coordinator (JAL-016). Manages Slack/Telegram plugin lifecycle,
   * approval token issuance, inbound action queues, and outbound event dispatch.
   */
  readonly pluginCoordinator: PluginCoordinator;
  /** JAL's persistent brain sphere — goal traces, provider events, working memory. */
  readonly jalBrain: JALBrain;
  /** Guardian's persistent brain sphere — verification history, domain knowledge. */
  readonly guardianBrain: GuardianBrain;

  private readonly apexHome: string;
  private readonly identityDocsDir: string;
  private readonly durableStore: DurableStore;
  /** True when a stub ProviderGateway was auto-created (no real gateway injected). */
  private readonly isStubGateway: boolean;
  /** Keychain backend selected by KeychainFactory — logged at start(). */
  private _keychainSelectionReason: string = '';
  private _keychainBackend: string = 'injected';

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

    // Canvas event bus — created early so approval callbacks can publish to it (JAL-013)
    this.eventBus = new EventBus();

    // Core audit + approval infrastructure
    this.auditLog = options.auditLog ?? new AuditLog();
    this.approvalService = new ApprovalService();
    this.allowlist = new PackageAllowlist(this.auditLog);

    // Wrap onApprovalRequired so Tier 2 approvals also publish to Canvas EventBus
    const eventBus = this.eventBus;
    const onApprovalRequired = options.onApprovalRequired
      ? (token: ApprovalToken) => {
          options.onApprovalRequired!(token);
          eventBus.publish(makeCanvasEvent('approval.requested', {
            approval_id: token.id,
            action: token.action,
            reason: token.reason,
            expires_at: token.expires_at,
          }, null, token.tier));
        }
      : (token: ApprovalToken) => {
          eventBus.publish(makeCanvasEvent('approval.requested', {
            approval_id: token.id,
            action: token.action,
            reason: token.reason,
            expires_at: token.expires_at,
          }, null, token.tier));
        };

    // Policy firewall — wires onApprovalRequired so REPL can intercept Tier 2
    this.firewall = new TieredFirewall(
      this.approvalService,
      this.auditLog,
      this.allowlist,
      onApprovalRequired
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
      onApprovalRequired
    );

    // Auth — uses injected keychain or auto-selects best available backend
    let keychain: IKeychain;
    if (options.keychain) {
      keychain = options.keychain;
    } else {
      const selection = createKeychain(options.stateDir);
      keychain = selection.keychain;
      // Audit log not yet wired here — keychain selection is logged in start()
      this._keychainSelectionReason = selection.reason;
      this._keychainBackend = selection.backend;
    }
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

    // Brain spheres — created unconditionally; files are only written when accessed
    this.jalBrain = new JALBrain(options.stateDir
      ? join(options.stateDir, '..', 'brains', 'jal')
      : undefined);
    this.guardianBrain = new GuardianBrain(options.stateDir
      ? join(options.stateDir, '..', 'brains', 'guardian')
      : undefined);

    // Provider gateway — injected, env-configured, or stub fallback
    if (options.providerGateway) {
      this.providerGateway = options.providerGateway;
      this.isStubGateway = false;
    } else {
      const defaultProvider = process.env['APEX_DEFAULT_PROVIDER'] ?? 'stub';
      const defaultModel = process.env['APEX_DEFAULT_MODEL'] ?? 'stub-model';

      this.providerGateway = new ProviderGateway({
        authManager: this.authManager,
        config: { provider: defaultProvider, model: defaultModel },
      });

      // Always register stub as fallback
      this.providerGateway.registerAdapter(new StubProviderAdapter('stub', '[stub response]'));

      // ── Local Ollama adapter (direct, single-model) ───────────────────────
      const ollamaAdapter = new OllamaAdapter();
      this.providerGateway.registerAdapter(ollamaAdapter);

      // ── Cloud provider adapters ────────────────────────────────────────────
      this.providerGateway.registerAdapter(new ClaudeAdapter());
      this.providerGateway.registerAdapter(new GeminiAdapter());
      this.providerGateway.registerAdapter(new OpenAIAdapter());

      // ── JAL student chain: qwen3:4b → gemma3:latest (local Ollama) ────────
      const jalStudentModel = process.env['APEX_DEFAULT_MODEL'] ?? 'qwen3:4b';
      const jalFallbackModel = process.env['APEX_JAL_FALLBACK_MODEL'] ?? 'gemma3:latest';
      const jalChain = new FallbackProviderChain('jal-chain', [
        { adapter: ollamaAdapter, model: jalStudentModel, token: '' },
        { adapter: ollamaAdapter, model: jalFallbackModel, token: '' },
      ]);
      this.providerGateway.registerAdapter(jalChain);

      // ── Guardian M_G chain: Claude → Gemini → OpenAI → gemma3 (local) ────
      const claudeToken = process.env['ANTHROPIC_API_KEY'] ?? '';
      const geminiToken = process.env['GEMINI_API_KEY'] ?? '';
      const openaiToken = process.env['OPENAI_API_KEY'] ?? '';
      const guardianFallbackModel = process.env['APEX_GUARDIAN_FALLBACK_MODEL'] ?? 'gemma3:latest';

      const guardianChain = new FallbackProviderChain('guardian-chain', [
        { adapter: new ClaudeAdapter(), model: 'claude-sonnet-4-6', token: claudeToken },
        { adapter: new GeminiAdapter(), model: 'gemini-2.5-flash', token: geminiToken },
        { adapter: new OpenAIAdapter(), model: 'gpt-4o', token: openaiToken },
        { adapter: ollamaAdapter, model: guardianFallbackModel, token: '' },
      ]);
      this.providerGateway.registerAdapter(guardianChain);

      // ── Guardian Angle ─────────────────────────────────────────────────────
      if (process.env['APEX_GUARDIAN_ENABLED'] === 'true') {
        const studentModel = process.env['APEX_GUARDIAN_STUDENT_MODEL'] ?? jalStudentModel;
        const guardianModel = process.env['APEX_GUARDIAN_MODEL'] ?? 'claude-sonnet-4-6';
        const guardianAdapter = new GuardianAngle({
          studentModel,
          guardianModel,
          // Inject pre-built chains
          studentAdapter: jalChain,
          guardianAdapter: guardianChain,
          brain: this.guardianBrain,
          entropyThreshold: process.env['APEX_GUARDIAN_ENTROPY_THRESHOLD']
            ? parseFloat(process.env['APEX_GUARDIAN_ENTROPY_THRESHOLD'])
            : undefined,
          sleepModeThreshold: process.env['APEX_GUARDIAN_SLEEP_THRESHOLD']
            ? parseFloat(process.env['APEX_GUARDIAN_SLEEP_THRESHOLD'])
            : undefined,
          sleepModeWindow: process.env['APEX_GUARDIAN_SLEEP_WINDOW']
            ? parseInt(process.env['APEX_GUARDIAN_SLEEP_WINDOW'], 10)
            : undefined,
        });
        this.providerGateway.registerAdapter(guardianAdapter);
      }

      this.isStubGateway = defaultProvider === 'stub';
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

    // Plugin coordinator (JAL-016) — runs as a local service inside ApexRuntime
    this.pluginCoordinator = new PluginCoordinator({ auditLog: this.auditLog });

    // Canvas server — disabled when options.canvas === false (e.g. in unit tests)
    if (options.canvas === false) {
      this.canvasServer = null;
    } else {
      const snapshotCollector = new SnapshotCollector(new ExecSyncShell());
      this.canvasServer = new CanvasServer(
        {
          sessionToken: '',   // placeholder — real token set in start()
          eventBus: this.eventBus,
          approvalService: this.approvalService,
          checkpointStore: this.checkpointStore,
          episodicStore,
          durableStore: this.durableStore,
          allowlist: this.allowlist,
          auditLog: this.auditLog,
          getSnapshot: () => snapshotCollector.collect(),
          pluginCoordinator: this.pluginCoordinator,
        },
        options.canvas ?? {},
      );
    }
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
    // Auto-login stub (always registered as fallback)
    await this.authManager.login('stub', 'stub-token-phase1', {
      auth_method: 'cli-hook',
      expires_at: null,
    });
    // Auto-login local adapters — no real credential required
    for (const provider of ['ollama', 'jal-chain', 'guardian-chain']) {
      await this.authManager.login(provider, `${provider}-local`, {
        auth_method: 'cli-hook',
        expires_at: null,
      });
    }
    // Auto-login cloud providers from env — tokens injected per-request by chains
    for (const [provider, envKey] of [
      ['claude', 'ANTHROPIC_API_KEY'],
      ['gemini', 'GEMINI_API_KEY'],
      ['openai', 'OPENAI_API_KEY'],
    ] as const) {
      const token = process.env[envKey];
      if (token) {
        await this.authManager.login(provider, token, { auth_method: 'api-key', expires_at: null });
      }
    }
    // Auto-login guardian if enabled
    if (process.env['APEX_GUARDIAN_ENABLED'] === 'true') {
      await this.authManager.login('guardian', 'guardian-local', {
        auth_method: 'cli-hook',
        expires_at: null,
      });
    }
    // Increment JAL brain session counter
    this.jalBrain.incrementSession();

    // Generate session token for Canvas WebSocket authentication (JAL-013)
    this.sessionToken = randomBytes(32).toString('hex');
    if (this.canvasServer) {
      this.canvasServer.setSessionToken(this.sessionToken);
      await this.canvasServer.start();
    }

    this.heartbeat.start();
    // Start plugin coordinator polling (JAL-016)
    this.pluginCoordinator.start();
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
      canvas_enabled: this.canvasServer !== null,
    });
    this.auditLog.write({
      timestamp: new Date().toISOString(),
      level: this._keychainBackend === 'memory' ? 'warn' : 'info',
      service: 'ApexRuntime',
      message: `Keychain backend: ${this._keychainBackend} — ${this._keychainSelectionReason}`,
      action: 'runtime.keychain_selected',
      backend: this._keychainBackend,
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
    // Stop plugin coordinator: expires in-flight tokens and disconnects plugins (JAL-016)
    this.pluginCoordinator.stop();

    for (const [execId] of this.shellEngine.getActiveExecutions()) {
      this.shellEngine.cancel(execId);
    }

    if (this.canvasServer) {
      await this.canvasServer.stop();
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

  /**
   * Convenience helper to publish a Canvas event to all connected clients (JAL-013).
   * Payload must never include credentials, tokens, or raw secrets.
   */
  publishCanvasEvent(
    event_type: import('../types').CanvasEventType,
    payload: Record<string, unknown>,
    task_id: string | null = null,
    tier: import('../types').PolicyTier | null = null,
  ): void {
    this.eventBus.publish(makeCanvasEvent(event_type, payload, task_id, tier));
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
      join(this.apexHome, 'brains', 'jal'),
      join(this.apexHome, 'brains', 'guardian'),
    ];
    for (const d of dirs) {
      mkdirSync(d, { recursive: true });
    }
  }
}
