// Co-authored by FORGE (Session: forge-20260325062232-1899997)
// src/apex/heartbeat/HeartbeatScheduler.ts — Configurable heartbeat scheduler
//
// Acceptance criteria:
//   - Default interval: 300 seconds (5 min). Configurable via APEX_HEARTBEAT_INTERVAL_SEC.
//   - Valid range: 60–1800 seconds (1–30 min). Out-of-range values are clamped.
//   - Health checks per cycle: disk pressure, process health, container status, failed jobs.
//   - Playbooks with staging=false and not degraded are executed when triggers fire.
//   - staging=true playbooks are queued for operator review (logged, never executed).
//   - All actions are audit-logged.
//   - A failed playbook step logs the error but does NOT halt the heartbeat cycle.

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { IAuditLog } from '../policy/AuditLog';
import { IHeartbeatShell, HealthChecks, DiskPressureTracker, ExecSyncShell } from './HealthChecks';
import { PlaybookRunner, PlaybookRunnerOptions } from './PlaybookRunner';
import { IPlaybookHealthStore, PlaybookHealthStore } from './PlaybookHealthStore';
import { HeartbeatCycleResult } from '../types';
import { NoOpAuditLog } from '../policy/AuditLog';

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_INTERVAL_SEC = 300;
const MIN_INTERVAL_SEC = 60;
const MAX_INTERVAL_SEC = 1800;
const HEARTBEAT_PROMPT_VERSION = 1;

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
}

export class HeartbeatScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly intervalMs: number;
  private readonly auditLog: IAuditLog;
  private readonly healthChecks: HealthChecks;
  private readonly playbookRunner: PlaybookRunner;
  private cycleCount = 0;
  private running = false;

  constructor(options: HeartbeatSchedulerOptions = {}) {
    // Resolve interval
    const rawSec =
      options.intervalSec ??
      parseInt(process.env['APEX_HEARTBEAT_INTERVAL_SEC'] ?? String(DEFAULT_INTERVAL_SEC), 10);
    const clampedSec = Math.max(MIN_INTERVAL_SEC, Math.min(MAX_INTERVAL_SEC, rawSec));
    this.intervalMs = clampedSec * 1000;

    this.auditLog = options.auditLog ?? new NoOpAuditLog();

    const shell = options.shell ?? new ExecSyncShell();
    const healthStore = options.healthStore ?? new PlaybookHealthStore();

    this.healthChecks = new HealthChecks(shell, options.diskTracker);
    this.playbookRunner = new PlaybookRunner(shell, this.auditLog, healthStore, {
      ...options.playbookOptions,
    });

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
      message: `Heartbeat started (interval=${this.intervalMs / 1000}s)`,
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
        // A playbook execution error must never crash the heartbeat cycle
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
