// Co-authored by FORGE (Session: forge-20260325062232-1899997)
// src/apex/checkpoint/CrashRecovery.ts — JAL-007 Crash Recovery Orchestration
//
// On process restart:
//  1. Loads the latest checkpoint from CheckpointStore
//  2. Marks all in-progress steps as 'interrupted'
//  3. Enqueues re-approval items for any interrupted Tier 2 steps
//  4. Resets all registered non-recoverable state handles (subprocess handles,
//     sockets, timers) — without attempting to restore them
//  5. Verifies SHA256 hashes of all referenced tool outputs
//  6. Persists the updated checkpoint back to disk

import { Checkpoint, PendingApproval } from '../types';
import { CheckpointStore } from './CheckpointStore';
import { OutputStore } from './OutputStore';

// ── Non-recoverable state interface ──────────────────────────────────────────

/**
 * Implement this on any component that holds state that cannot be serialised
 * and restored across a process boundary (subprocess handles, network sockets,
 * setInterval / setTimeout handles, etc.).
 *
 * `resetForRecovery()` MUST only perform cleanup — never attempt to restore
 * the original handle or reconnect automatically.
 */
export interface INonRecoverableStateReset {
  /**
   * Display name used in RecoveryResult.reset_state for observability.
   * Should be unique per component (e.g. "ShellEngine", "HeartbeatScheduler").
   */
  readonly componentName: string;

  /**
   * Called during crash recovery.  Implementations must:
   *  - Cancel / kill any in-flight subprocesses
   *  - Clear internal maps of active handles
   *  - Stop any running timers
   *  - NOT attempt to reconnect or restart
   */
  resetForRecovery(): void;
}

// ── Result type ───────────────────────────────────────────────────────────────

export interface RecoveryResult {
  /** True when a checkpoint was found and recovery was attempted. */
  recovered: boolean;
  /**
   * The restored (and possibly modified) checkpoint, or null when no
   * checkpoint existed.
   */
  checkpoint: Checkpoint | null;
  /** IDs of steps that were transitioned from in_progress → interrupted. */
  interrupted_steps: string[];
  /**
   * IDs of interrupted Tier 2 steps for which re-approval has been queued.
   * Callers must resolve these before allowing the task to resume.
   */
  reapproval_required: string[];
  /** Component names whose non-recoverable state was explicitly reset. */
  reset_state: string[];
  /** ISO timestamp at which recovery ran. */
  recovered_at: string;
  /**
   * Output verification errors, if any.  Non-empty means at least one
   * tool output hash failed to verify — the task should not resume until
   * these are inspected.
   */
  output_verification_errors: string[];
}

// ── CrashRecovery ─────────────────────────────────────────────────────────────

export class CrashRecovery {
  constructor(
    private readonly store: CheckpointStore,
    private readonly outputStore: OutputStore,
    private readonly stateResets: INonRecoverableStateReset[] = []
  ) {}

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Execute the full crash-recovery sequence.
   *
   * This is designed to be fast (MTTR target < 10 s) because it only
   * performs synchronous disk reads, in-memory state mutations, and a single
   * disk write for the updated checkpoint.  No network I/O, no subprocess
   * spawning.
   */
  recover(): RecoveryResult {
    const recovered_at = new Date().toISOString();

    const checkpoint = this.store.loadLatest();

    if (!checkpoint) {
      return {
        recovered: false,
        checkpoint: null,
        interrupted_steps: [],
        reapproval_required: [],
        reset_state: [],
        recovered_at,
        output_verification_errors: [],
      };
    }

    const interrupted_steps: string[] = [];
    const reapproval_required: string[] = [];

    // Step 1 — mark all in-flight steps as interrupted
    for (const step of checkpoint.steps) {
      if (step.status === 'in_progress') {
        step.status = 'interrupted';
        interrupted_steps.push(step.id);

        // Step 2 — Tier 2 interrupted steps require re-approval before resuming
        if (step.tier === 2) {
          const alreadyQueued = checkpoint.pending_approvals.some(
            p => p.step_id === step.id
          );
          if (!alreadyQueued) {
            const approval: PendingApproval = {
              step_id: step.id,
              action: `step.resume.${step.id}`,
              tier: 2,
              requested_at: recovered_at,
            };
            checkpoint.pending_approvals.push(approval);
          }
          reapproval_required.push(step.id);
        }
      }
    }

    // Sync the denormalised step_status field with the current step's real status
    const currentStep = checkpoint.steps[checkpoint.current_step];
    if (currentStep !== undefined) {
      checkpoint.step_status = currentStep.status;
    }

    checkpoint.updated_at = recovered_at;

    // Step 3 — persist the updated checkpoint atomically
    this.store.save(checkpoint);

    // Step 4 — reset non-recoverable state (subprocess handles, sockets, timers)
    // These components MUST NOT attempt to restore their previous state.
    const reset_state: string[] = [];
    for (const resetter of this.stateResets) {
      resetter.resetForRecovery();
      reset_state.push(resetter.componentName);
    }

    // Step 5 — verify all tool output hashes (safety gate)
    const output_verification_errors = this.verifyOutputs(checkpoint);

    return {
      recovered: true,
      checkpoint,
      interrupted_steps,
      reapproval_required,
      reset_state,
      recovered_at,
      output_verification_errors,
    };
  }

  /**
   * Verify every ToolOutputRef in the checkpoint.
   * Returns an array of error strings; empty means all hashes verified.
   *
   * Called internally by `recover()` but also exposed so callers can
   * re-verify at any point without running a full recovery sequence.
   */
  verifyOutputs(checkpoint: Checkpoint): string[] {
    const errors: string[] = [];
    for (const [key, ref] of Object.entries(checkpoint.tool_outputs_ref)) {
      try {
        this.outputStore.retrieve(ref);
      } catch (err) {
        errors.push(
          `Output ref '${key}' (hash=${ref.hash}): ${(err as Error).message}`
        );
      }
    }
    return errors;
  }
}
