// Co-authored by FORGE (Session: forge-20260325062232-1899997)
// tests/checkpoint/CrashRecovery.test.ts — JAL-007

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CrashRecovery, INonRecoverableStateReset } from '../../src/apex/checkpoint/CrashRecovery';
import { CheckpointStore } from '../../src/apex/checkpoint/CheckpointStore';
import { OutputStore, LARGE_OUTPUT_THRESHOLD_BYTES } from '../../src/apex/checkpoint/OutputStore';
import { Checkpoint, CheckpointStep } from '../../src/apex/types';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'apex-crash-recovery-'));
}

function makeStep(
  id: string,
  status: CheckpointStep['status'],
  tier: 1 | 2 | 3 = 1
): CheckpointStep {
  return { id, name: `Step ${id}`, status, tier };
}

function makeCheckpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    schema_version: 1,
    task_id: 'task-recover',
    goal: 'run recovery test',
    current_step: 0,
    step_status: 'pending',
    steps: [makeStep('s0', 'pending')],
    pending_approvals: [],
    tool_outputs_ref: {},
    policy_snapshot_hash: 'snap-hash',
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

class MockStateReset implements INonRecoverableStateReset {
  readonly componentName = 'MockComponent';
  resetCalled = false;
  resetForRecovery(): void {
    this.resetCalled = true;
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('CrashRecovery', () => {
  let tmpDir: string;
  let cpStore: CheckpointStore;
  let outStore: OutputStore;
  let recovery: CrashRecovery;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    cpStore = new CheckpointStore(tmpDir);
    outStore = new OutputStore(tmpDir);
    recovery = new CrashRecovery(cpStore, outStore);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── No checkpoint ─────────────────────────────────────────────────────────────

  describe('when no checkpoint exists', () => {
    it('returns recovered=false with empty arrays', () => {
      const result = recovery.recover();

      expect(result.recovered).toBe(false);
      expect(result.checkpoint).toBeNull();
      expect(result.interrupted_steps).toHaveLength(0);
      expect(result.reapproval_required).toHaveLength(0);
      expect(result.reset_state).toHaveLength(0);
      expect(result.output_verification_errors).toHaveLength(0);
    });
  });

  // ── in_progress → interrupted ─────────────────────────────────────────────────

  describe('in_progress step marking', () => {
    it('marks a single in_progress step as interrupted', () => {
      const cp = makeCheckpoint({
        steps: [makeStep('s0', 'in_progress')],
        current_step: 0,
        step_status: 'in_progress',
      });
      cpStore.save(cp);

      const result = recovery.recover();

      expect(result.recovered).toBe(true);
      expect(result.interrupted_steps).toEqual(['s0']);
      expect(result.checkpoint!.steps[0]!.status).toBe('interrupted');
      expect(result.checkpoint!.step_status).toBe('interrupted');
    });

    it('marks multiple in_progress steps as interrupted', () => {
      const cp = makeCheckpoint({
        steps: [
          makeStep('s0', 'completed'),
          makeStep('s1', 'in_progress'),
          makeStep('s2', 'in_progress'),
        ],
        current_step: 1,
        step_status: 'in_progress',
      });
      cpStore.save(cp);

      const result = recovery.recover();

      expect(result.interrupted_steps).toEqual(['s1', 's2']);
      expect(result.checkpoint!.steps[0]!.status).toBe('completed'); // unchanged
      expect(result.checkpoint!.steps[1]!.status).toBe('interrupted');
      expect(result.checkpoint!.steps[2]!.status).toBe('interrupted');
    });

    it('leaves pending and completed steps untouched', () => {
      const cp = makeCheckpoint({
        steps: [
          makeStep('s0', 'completed'),
          makeStep('s1', 'pending'),
          makeStep('s2', 'failed'),
        ],
      });
      cpStore.save(cp);

      const result = recovery.recover();

      expect(result.interrupted_steps).toHaveLength(0);
      expect(result.checkpoint!.steps[0]!.status).toBe('completed');
      expect(result.checkpoint!.steps[1]!.status).toBe('pending');
      expect(result.checkpoint!.steps[2]!.status).toBe('failed');
    });
  });

  // ── Tier 2 re-approval ────────────────────────────────────────────────────────

  describe('Tier 2 re-approval', () => {
    it('queues re-approval for an interrupted Tier 2 step', () => {
      const cp = makeCheckpoint({
        steps: [makeStep('s0', 'in_progress', 2)],
        current_step: 0,
        step_status: 'in_progress',
      });
      cpStore.save(cp);

      const result = recovery.recover();

      expect(result.reapproval_required).toEqual(['s0']);
      expect(result.checkpoint!.pending_approvals).toHaveLength(1);
      expect(result.checkpoint!.pending_approvals[0]!.step_id).toBe('s0');
      expect(result.checkpoint!.pending_approvals[0]!.tier).toBe(2);
    });

    it('does NOT queue re-approval for Tier 1 interrupted steps', () => {
      const cp = makeCheckpoint({
        steps: [makeStep('s0', 'in_progress', 1)],
      });
      cpStore.save(cp);

      const result = recovery.recover();

      expect(result.reapproval_required).toHaveLength(0);
      expect(result.checkpoint!.pending_approvals).toHaveLength(0);
    });

    it('does NOT queue re-approval for Tier 3 interrupted steps (already blocked)', () => {
      const cp = makeCheckpoint({
        steps: [makeStep('s0', 'in_progress', 3)],
      });
      cpStore.save(cp);

      const result = recovery.recover();

      expect(result.reapproval_required).toHaveLength(0);
      expect(result.checkpoint!.pending_approvals).toHaveLength(0);
    });

    it('does not duplicate pending_approvals if entry already existed for that step', () => {
      const cp = makeCheckpoint({
        steps: [makeStep('s0', 'in_progress', 2)],
        pending_approvals: [
          {
            step_id: 's0',
            action: 'step.resume.s0',
            tier: 2,
            requested_at: new Date().toISOString(),
          },
        ],
      });
      cpStore.save(cp);

      const result = recovery.recover();

      // Still must report it in reapproval_required (so caller knows)
      expect(result.reapproval_required).toEqual(['s0']);
      // But pending_approvals should not be doubled
      expect(result.checkpoint!.pending_approvals).toHaveLength(1);
    });

    it('handles a mix of Tier 1 and Tier 2 in_progress steps correctly', () => {
      const cp = makeCheckpoint({
        steps: [
          makeStep('s0', 'completed'),
          makeStep('s1', 'in_progress', 1), // Tier 1 — no re-approval
          makeStep('s2', 'in_progress', 2), // Tier 2 — needs re-approval
        ],
        current_step: 2,
      });
      cpStore.save(cp);

      const result = recovery.recover();

      expect(result.interrupted_steps).toEqual(['s1', 's2']);
      expect(result.reapproval_required).toEqual(['s2']);
      expect(result.checkpoint!.pending_approvals).toHaveLength(1);
    });
  });

  // ── Checkpoint persistence ────────────────────────────────────────────────────

  describe('checkpoint persistence after recovery', () => {
    it('saves the updated checkpoint back to disk', () => {
      const cp = makeCheckpoint({
        steps: [makeStep('s0', 'in_progress')],
      });
      cpStore.save(cp);

      recovery.recover();

      // Reload from disk and verify the update was persisted
      const reloaded = cpStore.loadLatest()!;
      expect(reloaded.steps[0]!.status).toBe('interrupted');
    });

    it('updates updated_at on recovery', () => {
      const original_at = '2020-01-01T00:00:00.000Z';
      const cp = makeCheckpoint({
        steps: [makeStep('s0', 'in_progress')],
        updated_at: original_at,
      });
      cpStore.save(cp);

      const result = recovery.recover();

      expect(result.checkpoint!.updated_at).not.toBe(original_at);
    });

    it('syncs step_status with current step status after marking interrupted', () => {
      const cp = makeCheckpoint({
        steps: [makeStep('s0', 'in_progress')],
        current_step: 0,
        step_status: 'in_progress',
      });
      cpStore.save(cp);

      const result = recovery.recover();

      expect(result.checkpoint!.step_status).toBe('interrupted');
    });
  });

  // ── Non-recoverable state reset ───────────────────────────────────────────────

  describe('non-recoverable state reset', () => {
    it('calls resetForRecovery() on all registered components', () => {
      const mock1 = new MockStateReset();
      const mock2 = new MockStateReset();
      const recoveryWithResets = new CrashRecovery(cpStore, outStore, [mock1, mock2]);

      cpStore.save(makeCheckpoint());
      recoveryWithResets.recover();

      expect(mock1.resetCalled).toBe(true);
      expect(mock2.resetCalled).toBe(true);
    });

    it('reports reset component names in reset_state', () => {
      const mock = new MockStateReset();
      const recoveryWithReset = new CrashRecovery(cpStore, outStore, [mock]);

      cpStore.save(makeCheckpoint());
      const result = recoveryWithReset.recover();

      expect(result.reset_state).toContain('MockComponent');
    });

    it('still resets state even if no steps were interrupted', () => {
      const mock = new MockStateReset();
      const recoveryWithReset = new CrashRecovery(cpStore, outStore, [mock]);

      cpStore.save(makeCheckpoint({ steps: [makeStep('s0', 'pending')] }));
      recoveryWithReset.recover();

      expect(mock.resetCalled).toBe(true);
    });

    it('does not reset state when no checkpoint exists', () => {
      const mock = new MockStateReset();
      const recoveryWithReset = new CrashRecovery(cpStore, outStore, [mock]);

      // No checkpoint saved — recover() should return early
      recoveryWithReset.recover();
      expect(mock.resetCalled).toBe(false);
    });
  });

  // ── Output hash verification (safety gate) ────────────────────────────────────

  describe('verifyOutputs() — SHA256 safety gate', () => {
    it('returns no errors when all inline refs are valid', () => {
      const content = 'small output';
      const ref = outStore.store(content);

      const cp = makeCheckpoint({
        tool_outputs_ref: { 'step-out': ref },
      });
      cpStore.save(cp);

      const result = recovery.recover();
      expect(result.output_verification_errors).toHaveLength(0);
    });

    it('returns no errors when all large refs are valid', () => {
      const content = 'L'.repeat(LARGE_OUTPUT_THRESHOLD_BYTES + 1);
      const ref = outStore.store(content);

      const cp = makeCheckpoint({
        tool_outputs_ref: { 'step-out': ref },
      });
      cpStore.save(cp);

      const result = recovery.recover();
      expect(result.output_verification_errors).toHaveLength(0);
    });

    it('reports an error for a missing on-disk output file', () => {
      const content = 'M'.repeat(LARGE_OUTPUT_THRESHOLD_BYTES + 1);
      const ref = outStore.store(content);

      // Delete the output file to simulate expiry / corruption
      fs.unlinkSync(path.join(tmpDir, 'outputs', ref.hash));

      const cp = makeCheckpoint({
        tool_outputs_ref: { 'step-out': ref },
      });
      cpStore.save(cp);

      const result = recovery.recover();
      expect(result.output_verification_errors).toHaveLength(1);
      expect(result.output_verification_errors[0]).toContain('step-out');
    });

    it('reports an error for a corrupted inline ref (tampered hash)', () => {
      const ref = outStore.store('hello');
      const tampered = { ...ref, hash: 'badhash000000000000000000000000000000000000000000000000000000ff' };

      const cp = makeCheckpoint({
        tool_outputs_ref: { 'step-out': tampered },
      });
      cpStore.save(cp);

      const result = recovery.recover();
      expect(result.output_verification_errors).toHaveLength(1);
    });

    it('verifyOutputs() can be called standalone', () => {
      const content = 'standalone check';
      const ref = outStore.store(content);

      const cp = makeCheckpoint({
        tool_outputs_ref: { 'ref-key': ref },
      });

      const errors = recovery.verifyOutputs(cp);
      expect(errors).toHaveLength(0);
    });

    it('verifyOutputs() reports all failing refs when multiple are bad', () => {
      const badRef1 = { hash: 'bad1bad1bad1bad1bad1bad1bad1bad1bad1bad1bad1bad1bad1bad1bad1bad1', size_bytes: 5, inline: 'wrong' };
      const badRef2 = { hash: 'bad2bad2bad2bad2bad2bad2bad2bad2bad2bad2bad2bad2bad2bad2bad2bad2', size_bytes: 5, inline: 'also-wrong' };

      const cp = makeCheckpoint({
        tool_outputs_ref: { 'ref-a': badRef1, 'ref-b': badRef2 },
      });

      const errors = recovery.verifyOutputs(cp);
      expect(errors).toHaveLength(2);
    });
  });

  // ── Tool cursor preservation ───────────────────────────────────────────────────

  describe('cursor fields are preserved through recovery', () => {
    it('retains cursor on a completed step after recovery', () => {
      const cp = makeCheckpoint({
        steps: [
          {
            id: 's0',
            name: 'Log stream',
            status: 'completed',
            tier: 1,
            cursor: { line_position: 250, pagination_token: 'tok-abc' },
          },
          makeStep('s1', 'in_progress'),
        ],
        current_step: 1,
      });
      cpStore.save(cp);

      const result = recovery.recover();

      const s0 = result.checkpoint!.steps[0]!;
      expect(s0.cursor?.line_position).toBe(250);
      expect(s0.cursor?.pagination_token).toBe('tok-abc');
    });

    it('does not add a cursor to steps that had none', () => {
      const cp = makeCheckpoint({
        steps: [makeStep('s0', 'in_progress')],
      });
      cpStore.save(cp);

      const result = recovery.recover();
      expect(result.checkpoint!.steps[0]!.cursor).toBeUndefined();
    });
  });
});
