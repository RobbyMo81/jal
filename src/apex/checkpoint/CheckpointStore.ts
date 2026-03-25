// Co-authored by FORGE (Session: forge-20260325062232-1899997)
// src/apex/checkpoint/CheckpointStore.ts — JAL-007 Checkpoint Persistence
//
// Stores and retrieves versioned task checkpoints as JSON files under
// ~/.apex/state/checkpoints/.  All writes are atomic (write-to-temp + rename).
//
// File layout:
//   <checkpointsDir>/<task_id>.checkpoint.json  — full checkpoint per task
//   <checkpointsDir>/latest.json                 — pointer to most-recently saved task

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Checkpoint } from '../types';

// ── LatestPointer ─────────────────────────────────────────────────────────────

interface LatestPointer {
  task_id: string;
  updated_at: string;
}

// ── CheckpointStore ───────────────────────────────────────────────────────────

export class CheckpointStore {
  private readonly checkpointsDir: string;

  constructor(stateDir?: string) {
    const base = stateDir ?? path.join(os.homedir(), '.apex', 'state');
    this.checkpointsDir = path.join(base, 'checkpoints');
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  private ensureDir(): void {
    fs.mkdirSync(this.checkpointsDir, { recursive: true });
  }

  private checkpointPath(taskId: string): string {
    return path.join(this.checkpointsDir, `${taskId}.checkpoint.json`);
  }

  private latestPath(): string {
    return path.join(this.checkpointsDir, 'latest.json');
  }

  /** Atomic write helper: write to .tmp then rename. */
  private atomicWrite(filePath: string, content: string): void {
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, filePath);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Persist a checkpoint atomically.
   * Also updates the latest.json pointer so `loadLatest()` works.
   */
  save(checkpoint: Checkpoint): void {
    this.ensureDir();

    const filePath = this.checkpointPath(checkpoint.task_id);
    this.atomicWrite(filePath, JSON.stringify(checkpoint, null, 2));

    const pointer: LatestPointer = {
      task_id: checkpoint.task_id,
      updated_at: checkpoint.updated_at,
    };
    this.atomicWrite(this.latestPath(), JSON.stringify(pointer, null, 2));
  }

  /**
   * Load a checkpoint by task ID.  Returns null if not found.
   */
  load(taskId: string): Checkpoint | null {
    const filePath = this.checkpointPath(taskId);
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw) as Checkpoint;
  }

  /**
   * Load the most recently saved checkpoint via the latest.json pointer.
   * Returns null if no checkpoint has ever been saved.
   */
  loadLatest(): Checkpoint | null {
    const latestFile = this.latestPath();
    if (!fs.existsSync(latestFile)) return null;

    const raw = fs.readFileSync(latestFile, 'utf8');
    const pointer = JSON.parse(raw) as LatestPointer;
    return this.load(pointer.task_id);
  }

  /**
   * Delete the checkpoint for a specific task.
   * No-op if the file does not exist.
   */
  delete(taskId: string): void {
    const filePath = this.checkpointPath(taskId);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  /**
   * List all task IDs that have a saved checkpoint.
   */
  list(): string[] {
    if (!fs.existsSync(this.checkpointsDir)) return [];
    return fs.readdirSync(this.checkpointsDir)
      .filter(f => f.endsWith('.checkpoint.json'))
      .map(f => f.slice(0, -'.checkpoint.json'.length));
  }
}
