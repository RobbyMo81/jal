// Co-authored by FORGE (Session: forge-20260325062232-1899997)
// tests/checkpoint/CheckpointStore.test.ts — JAL-007

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CheckpointStore } from '../../src/apex/checkpoint/CheckpointStore';
import { Checkpoint } from '../../src/apex/types';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'apex-cp-store-'));
}

function makeCheckpoint(taskId: string, overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    schema_version: 1,
    task_id: taskId,
    goal: 'test goal',
    current_step: 0,
    step_status: 'pending',
    steps: [
      { id: 'step-1', name: 'Step 1', status: 'pending', tier: 1 },
    ],
    pending_approvals: [],
    tool_outputs_ref: {},
    policy_snapshot_hash: 'abc123',
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('CheckpointStore', () => {
  let tmpDir: string;
  let store: CheckpointStore;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new CheckpointStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── save() / load() ───────────────────────────────────────────────────────────

  describe('save() and load()', () => {
    it('persists and retrieves a checkpoint by task ID', () => {
      const cp = makeCheckpoint('task-abc');
      store.save(cp);

      const loaded = store.load('task-abc');
      expect(loaded).not.toBeNull();
      expect(loaded!.task_id).toBe('task-abc');
      expect(loaded!.goal).toBe('test goal');
      expect(loaded!.schema_version).toBe(1);
    });

    it('creates the checkpoints directory if it does not exist', () => {
      const checkpointsDir = path.join(tmpDir, 'checkpoints');
      expect(fs.existsSync(checkpointsDir)).toBe(false);

      store.save(makeCheckpoint('task-x'));
      expect(fs.existsSync(checkpointsDir)).toBe(true);
    });

    it('overwrites a previous checkpoint for the same task ID', () => {
      store.save(makeCheckpoint('task-dup', { goal: 'first' }));
      store.save(makeCheckpoint('task-dup', { goal: 'second' }));

      const loaded = store.load('task-dup');
      expect(loaded!.goal).toBe('second');
    });

    it('returns null for an unknown task ID', () => {
      expect(store.load('does-not-exist')).toBeNull();
    });

    it('writes atomically (no partial JSON visible during write)', () => {
      // Verify the .tmp file is cleaned up after save
      const cp = makeCheckpoint('task-atomic');
      store.save(cp);

      const checkpointsDir = path.join(tmpDir, 'checkpoints');
      const files = fs.readdirSync(checkpointsDir);
      const tmpFiles = files.filter(f => f.endsWith('.tmp'));
      expect(tmpFiles).toHaveLength(0);
    });

    it('round-trips all checkpoint fields faithfully', () => {
      const now = new Date().toISOString();
      const cp: Checkpoint = {
        schema_version: 1,
        task_id: 'task-full',
        goal: 'full round-trip',
        current_step: 1,
        step_status: 'in_progress',
        steps: [
          { id: 's0', name: 'Read', status: 'completed', tier: 1, completed_at: now },
          { id: 's1', name: 'Write', status: 'in_progress', tier: 2, started_at: now,
            cursor: { line_position: 42 } },
        ],
        pending_approvals: [
          { step_id: 's1', action: 'step.resume.s1', tier: 2, requested_at: now }
        ],
        tool_outputs_ref: {
          's0-out': { hash: 'deadbeef', size_bytes: 5, inline: 'hello' },
        },
        policy_snapshot_hash: 'ff00ff',
        updated_at: now,
      };

      store.save(cp);
      const loaded = store.load('task-full')!;

      expect(loaded.current_step).toBe(1);
      expect(loaded.step_status).toBe('in_progress');
      expect(loaded.steps).toHaveLength(2);
      expect(loaded.steps[1]!.cursor?.line_position).toBe(42);
      expect(loaded.pending_approvals).toHaveLength(1);
      expect(loaded.tool_outputs_ref['s0-out']!.inline).toBe('hello');
    });
  });

  // ── loadLatest() ──────────────────────────────────────────────────────────────

  describe('loadLatest()', () => {
    it('returns null when no checkpoint has been saved', () => {
      expect(store.loadLatest()).toBeNull();
    });

    it('returns the most recently saved checkpoint', () => {
      store.save(makeCheckpoint('task-old', { updated_at: '2026-01-01T00:00:00.000Z' }));
      store.save(makeCheckpoint('task-new', { updated_at: '2026-03-01T00:00:00.000Z' }));

      const latest = store.loadLatest();
      expect(latest!.task_id).toBe('task-new');
    });

    it('tracks latest pointer even when multiple tasks exist', () => {
      store.save(makeCheckpoint('task-a'));
      store.save(makeCheckpoint('task-b'));
      store.save(makeCheckpoint('task-c'));

      expect(store.loadLatest()!.task_id).toBe('task-c');
    });
  });

  // ── delete() ──────────────────────────────────────────────────────────────────

  describe('delete()', () => {
    it('removes a checkpoint file', () => {
      store.save(makeCheckpoint('task-del'));
      expect(store.load('task-del')).not.toBeNull();

      store.delete('task-del');
      expect(store.load('task-del')).toBeNull();
    });

    it('is a no-op for a non-existent task ID', () => {
      expect(() => store.delete('ghost')).not.toThrow();
    });
  });

  // ── list() ────────────────────────────────────────────────────────────────────

  describe('list()', () => {
    it('returns an empty array when no checkpoints exist', () => {
      expect(store.list()).toEqual([]);
    });

    it('returns all saved task IDs', () => {
      store.save(makeCheckpoint('t1'));
      store.save(makeCheckpoint('t2'));
      store.save(makeCheckpoint('t3'));

      const ids = store.list().sort();
      expect(ids).toEqual(['t1', 't2', 't3']);
    });

    it('does not include latest.json or .tmp files in the list', () => {
      store.save(makeCheckpoint('real-task'));

      // Manually plant a stray .tmp
      const checkpointsDir = path.join(tmpDir, 'checkpoints');
      fs.writeFileSync(path.join(checkpointsDir, 'stray.tmp'), 'garbage');

      const ids = store.list();
      expect(ids).toEqual(['real-task']);
    });
  });
});
