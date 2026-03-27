// Co-authored by FORGE (Session: forge-20260326221916-3025550)
// src/apex/heartbeat/HeartbeatScheduler.ts — JAL-006 + JAL-010 Heartbeat Scheduler
//
// JAL-006: configurable heartbeat loop, playbook execution, audit-logging.
// JAL-010: environment snapshot collection, delta analysis, change classification,
//          episodic memory writes for notable changes, urgent escalation to audit bus,
//          periodic heartbeat narrative stored as durable context entry.
//
// Acceptance criteria:
//   - Default interval: 300 seconds (5 min). Configurable via APEX_HEARTBEAT_INTERVAL_SEC.
//   - Valid range: 60–1800 seconds (1–30 min). Out-of-range values are clamped.
//   - Health checks per cycle: disk pressure, process health, container status, failed jobs.
//   - Playbooks with staging=false and not degraded are executed when triggers fire.
//   - staging=true playbooks are queued for operator review (logged, never executed).
//   - All heartbeat actions are audit-logged.
//   - A failed playbook step does NOT halt the heartbeat cycle.
//   - Every pulse produces an EnvironmentSnapshot; deltas are classified per Behavior.md.
//   - Routine → audit log only. Notable → episodic memory. Urgent → audit log (error) + episodic.
//   - Every N pulses (default 12) a heartbeat_narrative is generated and stored in durable context.

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import * as crypto from 'crypto';
import { IAuditLog } from '../policy/AuditLog';
import { IHeartbeatShell, HealthChecks, DiskPressureTracker, ExecSyncShell } from './HealthChecks';
import { PlaybookRunner, PlaybookRunnerOptions } from './PlaybookRunner';
import { IPlaybookHealthStore, PlaybookHealthStore } from './PlaybookHealthStore';
import { SnapshotCollector } from './EnvironmentSnapshot';
import { DeltaAnalyzer, buildDeterministicNarrative } from './DeltaAnalyzer';
import { EpisodicStore } from '../memory/EpisodicStore';
import { DurableStore } from '../memory/DurableStore';
import { HeartbeatCycleResult, EnvironmentSnapshot, EnvironmentDelta, MemoryItem } from '../types';
import { NoOpAuditLog } from '../policy/AuditLog';

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_INTERVAL_SEC = 300;
const MIN_INTERVAL_SEC = 60;
const MAX_INTERVAL_SEC = 1800;
const HEARTBEAT_PROMPT_VERSION = 1;
const DEFAULT_NARRATIVE_PULSES = 12;
const APEX_WORKSPACE_ID = 'apex_system';
const HEARTBEAT_NARRATIVE_ITEM_ID = 'heartbeat_narrative';

// ── HeartbeatScheduler ────────────────────────────────────────────────────────

export interface HeartbeatSchedulerOptions {
  /** Override shell executor (for testing). Defaults to ExecSyncShell. */
  shell?: IHeartbeatShell;
  /** Override health store (for testing). Defaults to PlaybookHealthStore. */
  healthStore?: IPlaybookHealthStore;
  /** Override audit log (for testing). Defaults to NoOpAuditLog. */
  auditLog?: IAuditLog;
  /** Override disk pressure tracker (for testing). */
  diskTracker?: DiskPressureTracker;
  /** Playbook runner options (e.g. playbooksDir, alert callbacks). */
  playbookOptions?: PlaybookRunnerOptions;
  /**
   * Interval in seconds. Defaults to APEX_HEARTBEAT_INTERVAL_SEC env var,
   * or DEFAULT_INTERVAL_SEC (300) if unset. Clamped to [60, 1800].
   */
  intervalSec?: number;
  /** Episodic store for writing notable/urgent delta observations. */
  episodicStore?: EpisodicStore;
  /** Durable store for writing the periodic heartbeat_narrative context entry. */
  durableStore?: DurableStore;
  /**
   * Number of pulses between narrative generation (default 12 ≈ 1 hour at 5-min interval).
   * Configurable via APEX_NARRATIVE_PULSES env var.
   */
  narrativePulsesN?: number;
}

export class HeartbeatScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly intervalMs: number;
  private readonly auditLog: IAuditLog;
  private readonly healthChecks: HealthChecks;
  private readonly playbookRunner: PlaybookRunner;
  private readonly snapshotCollector: SnapshotCollector;
  private readonly deltaAnalyzer: DeltaAnalyzer;
  private readonly episodicStore: EpisodicStore | null;
  private readonly durableStore: DurableStore | null;
  private readonly narrativePulsesN: number;

  private cycleCount = 0;
  private running = false;
  private previousSnapshot: EnvironmentSnapshot | null = null;
  /** Accumulated notable+urgent deltas since last narrative write. */
  private pendingNarrativeDeltas: EnvironmentDelta[] = [];

  constructor(options: HeartbeatSchedulerOptions = {}) {
    // Resolve interval
    const rawSec =
      options.intervalSec ??
      parseInt(process.env['APEX_HEARTBEAT_INTERVAL_SEC'] ?? String(DEFAULT_INTERVAL_SEC), 10);
    const clampedSec = Math.max(MIN_INTERVAL_SEC, Math.min(MAX_INTERVAL_SEC, rawSec));
    this.intervalMs = clampedSec * 1000;

    // Narrative pulse count
    const rawNarrative =
      options.narrativePulsesN ??
      parseInt(process.env['APEX_NARRATIVE_PULSES'] ?? String(DEFAULT_NARRATIVE_PULSES), 10);
    this.narrativePulsesN = isNaN(rawNarrative) || rawNarrative < 1 ? DEFAULT_NARRATIVE_PULSES : rawNarrative;

    this.auditLog = options.auditLog ?? new NoOpAuditLog();

    const shell = options.shell ?? new ExecSyncShell();
    const healthStore = options.healthStore ?? new PlaybookHealthStore();

    this.healthChecks = new HealthChecks(shell, options.diskTracker);
    this.playbookRunner = new PlaybookRunner(shell, this.auditLog, healthStore, {
      ...options.playbookOptions,
    });

    this.snapshotCollector = new SnapshotCollector(shell);
    this.deltaAnalyzer = new DeltaAnalyzer();

    this.episodicStore = options.episodicStore ?? null;
    this.durableStore = options.durableStore ?? null;

    // Ensure the heartbeat prompt template exists
    this.ensurePromptTemplate();
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  /** Start the heartbeat loop. Runs the first cycle immediately. */
  start(): void {
    if (this.running) return;
    this.running = true;

    this.auditLog.write({
      timestamp: new Date().toISOString(),
      level: 'info',
      service: 'HeartbeatScheduler',
      message: `Heartbeat started (interval=${this.intervalMs / 1000}s, narrativeEvery=${this.narrativePulsesN})`,
      action: 'heartbeat.start',
      interval_sec: this.intervalMs / 1000,
    });

    // Run immediately, then on interval
    this.runCycle().catch((e) => this.logCycleError(e));
    this.timer = setInterval(() => {
      this.runCycle().catch((e) => this.logCycleError(e));
    }, this.intervalMs);
  }

  /** Stop the heartbeat loop. */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.auditLog.write({
      timestamp: new Date().toISOString(),
      level: 'info',
      service: 'HeartbeatScheduler',
      message: `Heartbeat stopped after ${this.cycleCount} cycle(s)`,
      action: 'heartbeat.stop',
      cycle_count: this.cycleCount,
    });
  }

  get isRunning(): boolean {
    return this.running;
  }

  get intervalSeconds(): number {
    return this.intervalMs / 1000;
  }

  // ── Cycle ───────────────────────────────────────────────────────────────────

  /** Run a single heartbeat cycle. Exposed for direct testing. */
  async runCycle(): Promise<HeartbeatCycleResult> {
    this.cycleCount += 1;
    const cycle_at = new Date().toISOString();
    const result: HeartbeatCycleResult = {
      cycle_at,
      checks: [],
      playbooks_triggered: [],
      playbooks_staged: [],
      errors: [],
    };

    this.auditLog.write({
      timestamp: cycle_at,
      level: 'info',
      service: 'HeartbeatScheduler',
      message: `Heartbeat cycle #${this.cycleCount} started`,
      action: 'heartbeat.cycle_start',
      cycle: this.cycleCount,
    });

    // ── Environment snapshot + delta analysis ─────────────────────────────────

    try {
      const snapshot = this.snapshotCollector.collect();
      const delta = this.deltaAnalyzer.analyze(this.previousSnapshot, snapshot);

      // Route changes by classification
      for (const d of delta.deltas) {
        if (d.classification === 'routine') {
          // Audit log only
          this.auditLog.write({
            timestamp: delta.timestamp,
            level: 'info',
            service: 'HeartbeatScheduler',
            message: `[routine] ${d.description}`,
            action: 'heartbeat.delta.routine',
            field: d.field,
          });
        } else if (d.classification === 'notable') {
          // Episodic memory + audit log
          this.writeToEpisodic(d, delta.timestamp, 'notable');
          this.pendingNarrativeDeltas.push(d);
          this.auditLog.write({
            timestamp: delta.timestamp,
            level: 'info',
            service: 'HeartbeatScheduler',
            message: `[notable] ${d.description}`,
            action: 'heartbeat.delta.notable',
            field: d.field,
          });
        } else {
          // urgent: episodic + audit error (immediate escalation / message bus)
          this.writeToEpisodic(d, delta.timestamp, 'urgent');
          this.pendingNarrativeDeltas.push(d);
          this.auditLog.write({
            timestamp: delta.timestamp,
            level: 'error',
            service: 'HeartbeatScheduler',
            message: `[URGENT] ${d.description}`,
            action: 'heartbeat.delta.urgent',
            field: d.field,
          });
        }
      }

      this.previousSnapshot = snapshot;
    } catch (e) {
      const msg = `Snapshot/delta error: ${(e as Error).message}`;
      result.errors.push(msg);
      this.auditLog.write({
        timestamp: new Date().toISOString(),
        level: 'error',
        service: 'HeartbeatScheduler',
        message: msg,
        action: 'heartbeat.snapshot_error',
      });
    }

    // ── Health checks (read-only) ─────────────────────────────────────────────

    const checks = await this.runHealthChecks();
    result.checks = checks;

    // Audit-log each check
    for (const check of checks) {
      this.auditLog.write({
        timestamp: check.checked_at,
        level: check.healthy ? 'info' : 'warn',
        service: 'HeartbeatScheduler',
        message: `Health check '${check.check}': ${check.healthy ? 'healthy' : 'unhealthy'} (exit_code=${check.exit_code})`,
        action: 'heartbeat.check',
        check: check.check,
        healthy: check.healthy,
        exit_code: check.exit_code,
        output_ref: check.output.slice(0, 256),
        ...check.metadata,
      });
    }

    // ── Playbook evaluation and execution ─────────────────────────────────────

    const playbooks = this.playbookRunner.loadPlaybooks();
    const { executable, staged } = this.playbookRunner.evaluateTriggers(playbooks, checks);
    result.playbooks_staged = staged.map((p) => p.name);

    for (const pb of executable) {
      try {
        const pbResult = await this.playbookRunner.executePlaybook(pb);
        result.playbooks_triggered.push(pb.name);
        if (pbResult.fatal_error) {
          result.errors.push(`${pb.name}: ${pbResult.fatal_error}`);
        }
      } catch (e) {
        const msg = `Playbook '${pb.name}' threw unexpectedly: ${(e as Error).message}`;
        result.errors.push(msg);
        this.auditLog.write({
          timestamp: new Date().toISOString(),
          level: 'error',
          service: 'HeartbeatScheduler',
          message: msg,
          action: 'heartbeat.playbook_error',
          playbook: pb.name,
        });
      }
    }

    // ── Narrative generation (every N pulses) ─────────────────────────────────

    if (this.cycleCount % this.narrativePulsesN === 0) {
      try {
        await this.writeNarrative();
      } catch (e) {
        const msg = `Narrative write error: ${(e as Error).message}`;
        result.errors.push(msg);
        this.auditLog.write({
          timestamp: new Date().toISOString(),
          level: 'error',
          service: 'HeartbeatScheduler',
          message: msg,
          action: 'heartbeat.narrative_error',
        });
      }
    }

    this.auditLog.write({
      timestamp: new Date().toISOString(),
      level: 'info',
      service: 'HeartbeatScheduler',
      message: `Heartbeat cycle #${this.cycleCount} complete`,
      action: 'heartbeat.cycle_end',
      cycle: this.cycleCount,
      playbooks_triggered: result.playbooks_triggered.length,
      playbooks_staged: result.playbooks_staged.length,
      errors: result.errors.length,
    });

    return result;
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private async runHealthChecks() {
    return [
      this.healthChecks.checkProcessHealth(),
      this.healthChecks.checkDiskPressure(),
      this.healthChecks.checkContainerStatus(),
      this.healthChecks.checkFailedJobs(),
    ];
  }

  private logCycleError(e: unknown): void {
    this.auditLog.write({
      timestamp: new Date().toISOString(),
      level: 'error',
      service: 'HeartbeatScheduler',
      message: `Cycle threw: ${(e as Error).message}`,
      action: 'heartbeat.cycle_error',
    });
  }

  /** Write a delta observation to episodic memory. */
  private writeToEpisodic(
    delta: EnvironmentDelta,
    timestamp: string,
    classification: 'notable' | 'urgent',
  ): void {
    if (!this.episodicStore) return;
    try {
      const now = new Date().toISOString();
      const content = `[${classification.toUpperCase()}] ${delta.description}`;
      const item: MemoryItem = {
        id: crypto.randomUUID(),
        tier: 'episodic',
        content,
        tags: ['heartbeat', classification, delta.field],
        workspace_id: APEX_WORKSPACE_ID,
        session_id: 'heartbeat',
        created_at: timestamp,
        last_accessed_at: now,
        access_count: 0,
        size_bytes: Buffer.byteLength(content, 'utf8'),
      };
      this.episodicStore.store(item);
    } catch {
      // Non-fatal — heartbeat cycle continues
    }
  }

  /** Generate a heartbeat narrative and store it in durable context. */
  private async writeNarrative(): Promise<void> {
    const capturedAt = this.previousSnapshot?.captured_at ?? new Date().toISOString();
    const narrative = buildDeterministicNarrative(
      this.pendingNarrativeDeltas,
      this.cycleCount,
      capturedAt,
    );

    if (this.durableStore) {
      const now = new Date().toISOString();
      const item: MemoryItem = {
        id: HEARTBEAT_NARRATIVE_ITEM_ID,
        tier: 'durable',
        content: narrative,
        tags: ['heartbeat', 'narrative', 'context'],
        workspace_id: APEX_WORKSPACE_ID,
        session_id: 'heartbeat',
        created_at: now,
        last_accessed_at: now,
        access_count: 0,
        size_bytes: Buffer.byteLength(narrative, 'utf8'),
      };
      // Direct store — heartbeat narratives are system-generated context,
      // not user-memory promotions. Bypasses MemoryManager.promoteToDurable() gate.
      this.durableStore.store(item);
    }

    this.auditLog.write({
      timestamp: new Date().toISOString(),
      level: 'info',
      service: 'HeartbeatScheduler',
      message: `Heartbeat narrative written (${this.pendingNarrativeDeltas.length} delta(s))`,
      action: 'heartbeat.narrative_written',
      pulse_count: this.cycleCount,
      delta_count: this.pendingNarrativeDeltas.length,
    });

    // Reset accumulated deltas for the next narrative window
    this.pendingNarrativeDeltas = [];
  }

  /**
   * Ensure the heartbeat prompt template file exists at
   * ~/.apex/policy/prompts/heartbeat.v{n}.md
   * Creates a default template if absent.
   */
  private ensurePromptTemplate(): void {
    const templatePath = join(
      homedir(),
      '.apex',
      'policy',
      'prompts',
      `heartbeat.v${HEARTBEAT_PROMPT_VERSION}.md`,
    );
    if (existsSync(templatePath)) return;
    try {
      mkdirSync(dirname(templatePath), { recursive: true });
      const template = [
        `# Apex Heartbeat Prompt — v${HEARTBEAT_PROMPT_VERSION}`,
        '',
        'You are the Apex heartbeat agent. Your role is to:',
        '1. Review the attached health check results.',
        '2. Identify any conditions that require operator attention.',
        '3. Summarise findings concisely (≤200 words).',
        '4. Do NOT take destructive actions. Observe only.',
        '5. NEVER include credentials, tokens, or raw command output in your summary.',
        '',
        '## Health Check Results',
        '{{checks}}',
        '',
        '## Triggered Playbooks',
        '{{playbooks_triggered}}',
        '',
        '## Staged Playbooks (operator review required)',
        '{{playbooks_staged}}',
      ].join('\n');
      writeFileSync(templatePath, template, 'utf-8');
    } catch {
      // Non-fatal — the scheduler works without the template
    }
  }
}
