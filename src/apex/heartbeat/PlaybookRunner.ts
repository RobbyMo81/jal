// Co-authored by FORGE (Session: forge-20260325062232-1899997)
// src/apex/heartbeat/PlaybookRunner.ts — Playbook loading, trigger evaluation, and execution
//
// Safety gates enforced here:
//   1. staging=false required before any playbook executes (staging=true → queued list only)
//   2. Degraded playbooks are skipped until operator clears the flag
//   3. Rollback failure → markDegraded() + operator alert callback + no retry
//   4. Every step and rollback action is audit-logged
//
// A failed step is logged but does NOT halt the heartbeat — execution continues to
// the next scheduled cycle.

import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { PlaybookDefinition, PlaybookTrigger, HeartbeatCheckResult } from '../types';
import { IAuditLog } from '../policy/AuditLog';
import { IHeartbeatShell } from './HealthChecks';
import { IPlaybookHealthStore } from './PlaybookHealthStore';
import { parsePlaybook, ParseError } from './YamlPlaybookParser';

// ── PlaybookRunner ────────────────────────────────────────────────────────────

export interface PlaybookRunResult {
  name: string;
  triggered: boolean;
  staged: boolean;        // true if skipped due to staging=true
  degraded: boolean;      // true if skipped due to degraded state
  steps_run: number;
  steps_failed: number;
  rollback_attempted: boolean;
  rollback_success: boolean;
  fatal_error?: string;
}

export interface PlaybookRunnerOptions {
  /** Directory to scan for *.yaml playbook files. Defaults to ~/.apex/policy/playbooks/. */
  playbooksDir?: string;
  /** Callback when a playbook enters degraded state — use for operator alerting. */
  onDegradeAlert?: (name: string, reason: string) => void;
  /** Callback when a staging=true playbook is encountered — queued for operator review. */
  onStagingQueued?: (name: string) => void;
}

export class PlaybookRunner {
  private readonly playbooksDir: string;
  private readonly onDegradeAlert: (name: string, reason: string) => void;
  private readonly onStagingQueued: (name: string) => void;

  constructor(
    private readonly shell: IHeartbeatShell,
    private readonly auditLog: IAuditLog,
    private readonly healthStore: IPlaybookHealthStore,
    options: PlaybookRunnerOptions = {},
  ) {
    this.playbooksDir =
      options.playbooksDir ?? join(homedir(), '.apex', 'policy', 'playbooks');
    this.onDegradeAlert = options.onDegradeAlert ?? (() => undefined);
    this.onStagingQueued = options.onStagingQueued ?? (() => undefined);
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Load all valid playbooks from the playbooks directory. */
  loadPlaybooks(): PlaybookDefinition[] {
    if (!existsSync(this.playbooksDir)) return [];

    const files = readdirSync(this.playbooksDir).filter((f) => f.endsWith('.yaml'));
    const playbooks: PlaybookDefinition[] = [];

    for (const file of files) {
      const fullPath = join(this.playbooksDir, file);
      try {
        const text = readFileSync(fullPath, 'utf-8');
        const pb = parsePlaybook(text, fullPath);
        playbooks.push(pb);
      } catch (e) {
        this.auditLog.write({
          timestamp: new Date().toISOString(),
          level: 'warn',
          service: 'PlaybookRunner',
          message: `Failed to load playbook: ${file}`,
          action: 'playbook.load_error',
          detail: (e as Error).message,
        });
      }
    }

    return playbooks;
  }

  /**
   * Evaluate which playbooks should be triggered given the current health check results.
   * Returns two arrays: one for executable playbooks (staging=false, not degraded),
   * one for staged playbooks (staging=true).
   */
  evaluateTriggers(
    playbooks: PlaybookDefinition[],
    checks: HeartbeatCheckResult[],
  ): { executable: PlaybookDefinition[]; staged: PlaybookDefinition[] } {
    const executable: PlaybookDefinition[] = [];
    const staged: PlaybookDefinition[] = [];

    for (const pb of playbooks) {
      if (!this.anyTriggerFired(pb.triggers, checks)) continue;

      // Safety gate: staging=true → queue for review, never execute
      if (pb.staging === true) {
        staged.push(pb);
        this.onStagingQueued(pb.name);
        this.auditLog.write({
          timestamp: new Date().toISOString(),
          level: 'info',
          service: 'PlaybookRunner',
          message: `Playbook '${pb.name}' triggered but staging=true — queued for operator review`,
          action: 'playbook.staged',
          playbook: pb.name,
        });
        continue;
      }

      // Safety gate: degraded playbooks are blocked
      if (this.healthStore.isDegraded(pb.name)) {
        this.auditLog.write({
          timestamp: new Date().toISOString(),
          level: 'warn',
          service: 'PlaybookRunner',
          message: `Playbook '${pb.name}' triggered but is in degraded state — skipped`,
          action: 'playbook.degraded_skip',
          playbook: pb.name,
        });
        continue;
      }

      executable.push(pb);
    }

    return { executable, staged };
  }

  /**
   * Execute a single playbook: run steps in order, attempt rollback on failure,
   * mark degraded if rollback also fails. Logs every action.
   * A step failure does NOT throw — caller can safely continue to next playbook.
   */
  async executePlaybook(pb: PlaybookDefinition): Promise<PlaybookRunResult> {
    const result: PlaybookRunResult = {
      name: pb.name,
      triggered: true,
      staged: false,
      degraded: false,
      steps_run: 0,
      steps_failed: 0,
      rollback_attempted: false,
      rollback_success: false,
    };

    this.auditLog.write({
      timestamp: new Date().toISOString(),
      level: 'info',
      service: 'PlaybookRunner',
      message: `Executing playbook '${pb.name}'`,
      action: 'playbook.start',
      playbook: pb.name,
      step_count: pb.steps.length,
    });

    let anyStepFailed = false;
    let failedStepName = '';

    for (const step of pb.steps) {
      result.steps_run += 1;
      const timeoutMs = (step.timeout ?? pb.max_runtime) * 1000;

      const stepStart = new Date().toISOString();
      const execResult = this.shell.exec(step.command, timeoutMs);

      this.auditLog.write({
        timestamp: stepStart,
        level: execResult.exit_code === 0 ? 'info' : 'warn',
        service: 'PlaybookRunner',
        message: `Step '${step.name}' exit_code=${execResult.exit_code}`,
        action: 'playbook.step',
        playbook: pb.name,
        step: step.name,
        exit_code: execResult.exit_code,
        stdout_ref: execResult.stdout.slice(0, 512),
        stderr_ref: execResult.stderr.slice(0, 512),
      });

      if (execResult.exit_code !== 0) {
        result.steps_failed += 1;
        anyStepFailed = true;
        failedStepName = step.name;
        // AC: "A failed playbook step is logged but does not halt the heartbeat"
        // We stop the current playbook's steps on failure and attempt rollback,
        // but the heartbeat cycle continues.
        break;
      }
    }

    this.healthStore.recordRun(pb.name, anyStepFailed ? 1 : 0);

    if (anyStepFailed) {
      result.rollback_attempted = true;
      const rollbackOk = this.runRollback(pb, failedStepName);
      result.rollback_success = rollbackOk;

      if (!rollbackOk && pb.rollback_failure_policy === 'degrade') {
        const reason = `Step '${failedStepName}' failed; rollback commands also failed`;
        result.degraded = true;
        this.healthStore.markDegraded(pb.name, reason);
        this.onDegradeAlert(pb.name, reason);
        this.auditLog.write({
          timestamp: new Date().toISOString(),
          level: 'error',
          service: 'PlaybookRunner',
          message: `Playbook '${pb.name}' marked DEGRADED — operator action required`,
          action: 'playbook.degraded',
          playbook: pb.name,
          reason,
        });
      }
    }

    this.auditLog.write({
      timestamp: new Date().toISOString(),
      level: anyStepFailed ? 'warn' : 'info',
      service: 'PlaybookRunner',
      message: `Playbook '${pb.name}' finished (steps_run=${result.steps_run}, failed=${result.steps_failed})`,
      action: 'playbook.finish',
      playbook: pb.name,
      steps_run: result.steps_run,
      steps_failed: result.steps_failed,
    });

    return result;
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private anyTriggerFired(
    triggers: PlaybookTrigger[],
    checks: HeartbeatCheckResult[],
  ): boolean {
    for (const trigger of triggers) {
      if (this.triggerFired(trigger, checks)) return true;
    }
    return false;
  }

  private triggerFired(
    trigger: PlaybookTrigger,
    checks: HeartbeatCheckResult[],
  ): boolean {
    switch (trigger.type) {
      case 'high_disk_pressure': {
        const dc = checks.find((c) => c.check === 'disk_pressure');
        return dc?.metadata?.['triggered'] === true;
      }
      case 'memory_pressure': {
        const mc = checks.find((c) => c.check === 'process_health' && c.metadata?.['available_mb'] !== undefined);
        return mc?.metadata?.['triggered'] === true;
      }
      case 'service_down': {
        if (!trigger.service) return false;
        const cmd = `systemctl is-active --quiet "${trigger.service}"`;
        const r = this.shell.exec(cmd, 5_000);
        return r.exit_code !== 0;
      }
      case 'failed_task': {
        const fc = checks.find((c) => c.check === 'failed_job');
        return fc?.metadata?.['triggered'] === true;
      }
      case 'custom': {
        if (!trigger.expression) return false;
        const r = this.shell.exec(`bash -c '${trigger.expression.replace(/'/g, "'\\''")}'`, 5_000);
        return r.exit_code === 0; // shell test expressions: exit 0 = condition met
      }
      default:
        return false;
    }
  }

  private runRollback(pb: PlaybookDefinition, failedStep: string): boolean {
    if (pb.rollback_commands.length === 0) {
      this.auditLog.write({
        timestamp: new Date().toISOString(),
        level: 'info',
        service: 'PlaybookRunner',
        message: `Playbook '${pb.name}' has no rollback commands`,
        action: 'playbook.rollback_skip',
        playbook: pb.name,
        failed_step: failedStep,
      });
      return true; // no rollback needed → treat as success
    }

    let allOk = true;
    for (const cmd of pb.rollback_commands) {
      const r = this.shell.exec(cmd, pb.max_runtime * 1000);
      this.auditLog.write({
        timestamp: new Date().toISOString(),
        level: r.exit_code === 0 ? 'info' : 'error',
        service: 'PlaybookRunner',
        message: `Rollback command exit_code=${r.exit_code}: ${cmd}`,
        action: 'playbook.rollback_step',
        playbook: pb.name,
        exit_code: r.exit_code,
        stdout_ref: r.stdout.slice(0, 512),
        stderr_ref: r.stderr.slice(0, 512),
      });
      if (r.exit_code !== 0) {
        allOk = false;
      }
    }

    return allOk;
  }
}
