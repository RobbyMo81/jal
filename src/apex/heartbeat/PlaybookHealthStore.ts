// Co-authored by FORGE (Session: forge-20260325062232-1899997)
// src/apex/heartbeat/PlaybookHealthStore.ts — Manages ~/.apex/state/playbook-health.json
//
// Tracks per-playbook degraded state. A degraded playbook is NOT executed by the heartbeat
// until the operator clears the flag (sets degraded: false) in the JSON file.
// All writes are atomic: write to .tmp then rename.

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { PlaybookHealthFile, PlaybookHealthEntry } from '../types';

// ── IPlaybookHealthStore ──────────────────────────────────────────────────────

export interface IPlaybookHealthStore {
  isDegraded(name: string): boolean;
  markDegraded(name: string, reason: string): void;
  recordRun(name: string, exitCode: number): void;
  getAll(): PlaybookHealthFile;
}

// ── PlaybookHealthStore ───────────────────────────────────────────────────────

export class PlaybookHealthStore implements IPlaybookHealthStore {
  private readonly filePath: string;
  private cache: PlaybookHealthFile | null = null;

  constructor(filePath?: string) {
    this.filePath = filePath ?? join(homedir(), '.apex', 'state', 'playbook-health.json');
  }

  isDegraded(name: string): boolean {
    const data = this.load();
    return data.playbooks[name]?.degraded === true;
  }

  markDegraded(name: string, reason: string): void {
    const data = this.load();
    const existing = data.playbooks[name] ?? { playbook: name, degraded: false };
    data.playbooks[name] = {
      ...existing,
      degraded: true,
      degraded_at: new Date().toISOString(),
      degraded_reason: reason,
    };
    data.version += 1;
    data.updated_at = new Date().toISOString();
    this.save(data);
  }

  recordRun(name: string, exitCode: number): void {
    const data = this.load();
    const existing = data.playbooks[name] ?? { playbook: name, degraded: false };
    data.playbooks[name] = {
      ...existing,
      last_run: new Date().toISOString(),
      last_exit_code: exitCode,
    };
    data.version += 1;
    data.updated_at = new Date().toISOString();
    this.save(data);
  }

  getAll(): PlaybookHealthFile {
    return this.load();
  }

  private load(): PlaybookHealthFile {
    // Re-read from disk each time to pick up operator edits (e.g., clearing degraded flag).
    if (!existsSync(this.filePath)) {
      return { version: 0, updated_at: new Date().toISOString(), playbooks: {} };
    }
    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      return JSON.parse(raw) as PlaybookHealthFile;
    } catch {
      // Corrupted file — return empty state rather than crashing the heartbeat.
      return { version: 0, updated_at: new Date().toISOString(), playbooks: {} };
    }
  }

  private save(data: PlaybookHealthFile): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = this.filePath + '.tmp';
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    renameSync(tmp, this.filePath);
    this.cache = data;
  }
}

// ── MemoryPlaybookHealthStore (test double) ───────────────────────────────────

/** In-memory implementation for unit tests — no filesystem access. */
export class MemoryPlaybookHealthStore implements IPlaybookHealthStore {
  private data: PlaybookHealthFile = { version: 0, updated_at: new Date().toISOString(), playbooks: {} };

  isDegraded(name: string): boolean {
    return this.data.playbooks[name]?.degraded === true;
  }

  markDegraded(name: string, reason: string): void {
    const existing = this.data.playbooks[name] ?? { playbook: name, degraded: false };
    this.data.playbooks[name] = {
      ...existing,
      degraded: true,
      degraded_at: new Date().toISOString(),
      degraded_reason: reason,
    };
    this.data.version += 1;
    this.data.updated_at = new Date().toISOString();
  }

  recordRun(name: string, exitCode: number): void {
    const existing = this.data.playbooks[name] ?? { playbook: name, degraded: false };
    this.data.playbooks[name] = {
      ...existing,
      last_run: new Date().toISOString(),
      last_exit_code: exitCode,
    };
    this.data.version += 1;
    this.data.updated_at = new Date().toISOString();
  }

  getAll(): PlaybookHealthFile {
    return this.data;
  }

  /** Test helper: pre-set a playbook's degraded state. */
  setDegraded(name: string, degraded: boolean): void {
    const existing = this.data.playbooks[name] ?? { playbook: name, degraded: false };
    this.data.playbooks[name] = { ...existing, degraded };
  }
}
