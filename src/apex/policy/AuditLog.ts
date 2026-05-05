// Co-authored by FORGE (Session: forge-20260324215726-1658598)
// src/apex/policy/AuditLog.ts — JAL-003 Append-only audit log with SHA-256 hash chaining
//
// Every entry is written synchronously so it is guaranteed to land before
// execution proceeds. The chain links entries via prev_hash → curr_hash so
// any tampering breaks the chain.
//
// Format: one JSON object per line (JSONL) at ~/.apex/audit/audit.log
// Hash: SHA-256 of the serialised entry (without curr_hash), truncated to 16 hex chars.

import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { AuditEntry } from '../types';

export interface AuditLogFilters {
  level?: string;
  action?: string;
  since?: string;  // ISO timestamp
  limit?: number;
}

// ── IAuditLog ─────────────────────────────────────────────────────────────────

/**
 * Minimal interface for audit logging.
 * Allows test doubles to be injected without touching the filesystem.
 */
export interface IAuditLog {
  write(entry: Omit<AuditEntry, 'prev_hash' | 'curr_hash'>): void;
}

// ── AuditLog ─────────────────────────────────────────────────────────────────

export class AuditLog implements IAuditLog {
  private readonly logPath: string;
  private prevHash = '';
  private dirEnsured = false;

  constructor(logPath?: string) {
    this.logPath = logPath ?? join(homedir(), '.apex', 'audit', 'audit.log');
  }

  /**
   * Append a single audit entry synchronously.
   * Computes prev_hash → curr_hash chain before writing.
   * Throws if the filesystem write fails — callers must treat this as fatal.
   */
  write(entry: Omit<AuditEntry, 'prev_hash' | 'curr_hash'>): void {
    this.ensureDir();

    // TypeScript cannot narrow Omit<AuditEntry,...> through spread when the
    // interface carries an index signature — use a cast here.
    const withPrev = { ...entry, prev_hash: this.prevHash } as AuditEntry;
    // Serialise without curr_hash for stable hash input
    const payload = JSON.stringify(withPrev);
    const curr = createHash('sha256').update(payload).digest('hex').slice(0, 16);
    const final: AuditEntry = { ...withPrev, curr_hash: curr };

    appendFileSync(this.logPath, JSON.stringify(final) + '
', 'utf-8');
    this.prevHash = curr;
  }

  /** Read and filter audit entries. Returns newest-first up to limit. */
  query(filters: AuditLogFilters = {}): AuditEntry[] {
    if (!existsSync(this.logPath)) return [];
    const lines = readFileSync(this.logPath, 'utf8').split('
').filter(Boolean);
    let entries: AuditEntry[] = [];
    for (const line of lines) {
      try { entries.push(JSON.parse(line) as AuditEntry); } catch { /* skip */ }
    }
    if (filters.level) entries = entries.filter(e => e.level === filters.level);
    if (filters.action) entries = entries.filter(e => (e as Record<string, unknown>)['action'] === filters.action);
    if (filters.since) {
      const since = new Date(filters.since).getTime();
      entries = entries.filter(e => new Date(e.timestamp).getTime() > since);
    }
    entries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    return filters.limit ? entries.slice(0, filters.limit) : entries.slice(0, 100);
  }

  private ensureDir(): void {
    if (!this.dirEnsured) {
      mkdirSync(dirname(this.logPath), { recursive: true });
      this.dirEnsured = true;
    }
  }
}

// ── NoOpAuditLog ──────────────────────────────────────────────────────────────

/** Discards all entries. Useful in unit tests or when audit logging is disabled. */
export class NoOpAuditLog implements IAuditLog {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  write(_entry: Omit<AuditEntry, 'prev_hash' | 'curr_hash'>): void {
    // intentional no-op
  }
}

/** Captures entries in memory for assertions in unit tests. */
export class CapturingAuditLog implements IAuditLog {
  readonly entries: Array<Omit<AuditEntry, 'prev_hash' | 'curr_hash'>> = [];

  write(entry: Omit<AuditEntry, 'prev_hash' | 'curr_hash'>): void {
    this.entries.push(entry);
  }
}
