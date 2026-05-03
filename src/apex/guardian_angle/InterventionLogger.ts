// Co-authored by Apex Wakening Build
// src/apex/guardian_angle/InterventionLogger.ts — Guardian intervention dataset logging
//
// Logs every Guardian correction as a "Corrected Pair" to NDJSON.
// Each record is a training-ready (student_draft, corrected_output) pair,
// enriched with domain, entropy score, and PoF index for LoRA fine-tuning.
//
// Format: one JSON object per line (NDJSON), append-only.
// File: ~/.apex/state/guardian/interventions.ndjson

import { appendFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { Domain, InterventionRecord } from './types';

// ── InterventionLogger ────────────────────────────────────────────────────────

export interface InterventionQueryOptions {
  domain?: Domain;
  limit?: number;
  since?: string;  // ISO timestamp — records after this date
}

export class InterventionLogger {
  private readonly logFile: string;

  constructor(stateDir?: string) {
    const dir = stateDir ?? join(homedir(), '.apex', 'state', 'guardian');
    mkdirSync(dir, { recursive: true });
    this.logFile = join(dir, 'interventions.ndjson');
  }

  /** Append an intervention record to the log. */
  log(record: InterventionRecord): void {
    appendFileSync(this.logFile, JSON.stringify(record) + '\n', 'utf8');
  }

  /**
   * Read and filter intervention records.
   * Returns records newest-first up to the limit.
   */
  query(opts: InterventionQueryOptions = {}): InterventionRecord[] {
    if (!existsSync(this.logFile)) return [];

    const lines = readFileSync(this.logFile, 'utf8')
      .split('\n')
      .filter(Boolean);

    let records: InterventionRecord[] = [];
    for (const line of lines) {
      try {
        records.push(JSON.parse(line) as InterventionRecord);
      } catch {
        // skip malformed lines
      }
    }

    if (opts.domain) {
      records = records.filter(r => r.domain === opts.domain);
    }
    if (opts.since) {
      const since = new Date(opts.since).getTime();
      records = records.filter(r => new Date(r.timestamp).getTime() > since);
    }

    // Newest first
    records.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    return opts.limit ? records.slice(0, opts.limit) : records;
  }

  /** Count total interventions, optionally filtered by domain. */
  count(domain?: Domain): number {
    return this.query({ domain }).length;
  }

  /** Path to the raw NDJSON file — expose for external tooling / LoRA pipelines. */
  get filePath(): string {
    return this.logFile;
  }
}
