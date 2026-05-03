// src/apex/brain/BrainStore.ts — File-backed persistent brain storage
//
// Each brain sphere uses a dedicated directory:
//   <brainDir>/working_memory.json   — structured JSON, rewritten on update
//   <brainDir>/<logName>.ndjson      — append-only NDJSON trace logs
//
// Multiple runtime instances sharing the same brainDir naturally share state
// because they read/write the same files. No in-process singleton needed.

import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from 'fs';
import { join } from 'path';
import type { WorkingMemory, BrainTraceEntry } from './types';

export class BrainStore<TMemory extends WorkingMemory> {
  private readonly brainDir: string;
  private readonly memoryFile: string;

  constructor(brainDir: string) {
    this.brainDir = brainDir;
    this.memoryFile = join(brainDir, 'working_memory.json');
    mkdirSync(brainDir, { recursive: true });
  }

  // ── Working memory ─────────────────────────────────────────────────────────

  readMemory(defaults: TMemory): TMemory {
    if (!existsSync(this.memoryFile)) return { ...defaults };
    try {
      const raw = readFileSync(this.memoryFile, 'utf8');
      return JSON.parse(raw) as TMemory;
    } catch {
      return { ...defaults };
    }
  }

  writeMemory(memory: TMemory): void {
    const updated: TMemory = { ...memory, updated_at: new Date().toISOString() };
    writeFileSync(this.memoryFile, JSON.stringify(updated, null, 2), 'utf8');
  }

  // ── JSON document files ────────────────────────────────────────────────────

  readDoc<T>(filename: string, defaults: T): T {
    const filePath = join(this.brainDir, filename);
    if (!existsSync(filePath)) return { ...defaults as object } as T;
    try {
      return JSON.parse(readFileSync(filePath, 'utf8')) as T;
    } catch {
      return { ...defaults as object } as T;
    }
  }

  writeDoc<T>(filename: string, data: T): void {
    writeFileSync(join(this.brainDir, filename), JSON.stringify(data, null, 2), 'utf8');
  }

  // ── NDJSON append log ──────────────────────────────────────────────────────

  appendLog(logName: string, entry: BrainTraceEntry): void {
    const filePath = join(this.brainDir, `${logName}.ndjson`);
    appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf8');
  }

  readLog(logName: string, limit = 100): BrainTraceEntry[] {
    const filePath = join(this.brainDir, `${logName}.ndjson`);
    if (!existsSync(filePath)) return [];
    try {
      const lines = readFileSync(filePath, 'utf8')
        .split('\n')
        .filter(Boolean);
      return lines
        .slice(-limit)
        .map(l => JSON.parse(l) as BrainTraceEntry)
        .reverse();
    } catch {
      return [];
    }
  }
}
