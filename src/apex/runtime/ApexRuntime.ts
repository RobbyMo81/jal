// Co-authored by FORGE (Session: forge-20260326213245-2999721)
// src/apex/runtime/ApexRuntime.ts — JAL-009 Unified Phase 1 Runtime Wiring
//
// Instantiates and wires all Phase 1 services into a single cohesive runtime:
//   ShellEngine, DockerEngine, TieredFirewall, PolicyFileOps, AuthManager,
//   HeartbeatScheduler, CheckpointStore, MemoryManager, AuditLog
//
// Lifecycle:
//   start()  — ensure ~/.apex/ dirs exist, start heartbeat, write startup audit entry
//   stop()   — stop heartbeat, cancel active shell procs, write shutdown audit entry

import { mkdirSync } from 'fs';
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
import { HeartbeatScheduler } from '../heartbeat/HeartbeatScheduler';
import { CheckpointStore } from '../checkpoint/CheckpointStore';
import { MemoryManager } from '../memory/MemoryManager';
import { ApprovalToken } from '../types';

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

  private readonly apexHome: string;

  constructor(options: ApexRuntimeOptions = {}) {
    this.apexHome = join(homedir(), '.apex');

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

    // Heartbeat, checkpoint, and memory — use auditLog for observability
    this.heartbeat = new HeartbeatScheduler({ auditLog: this.auditLog });
    this.checkpointStore = new CheckpointStore(options.stateDir);
    this.memoryManager = new MemoryManager(options.stateDir);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────────

  /**
   * Start the runtime:
   *   1. Ensure all ~/.apex/ subdirectories exist (creates if missing).
   *   2. Start the heartbeat scheduler.
   *   3. Write a startup audit entry.
   */
  async start(): Promise<void> {
    this.ensureApexDirs();
    this.heartbeat.start();
    this.auditLog.write({
      timestamp: new Date().toISOString(),
      level: 'info',
      service: 'ApexRuntime',
      message: `ApexRuntime v${this.version} started`,
      action: 'runtime.start',
      heartbeat_interval_sec: this.heartbeat.intervalSeconds,
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
