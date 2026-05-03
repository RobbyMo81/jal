// Co-authored by Apex Wakening Build
// src/apex/guardian_angle/DomainSleepTracker.ts — Domain accuracy tracking & Sleep Mode
//
// Tracks M_S accuracy per domain over a sliding window (ring buffer).
// When accuracy >= τ for a full window, the Guardian enters "Sleep Mode"
// for that domain — saving 100% of Guardian tokens for well-learned domains.
// Wakes when accuracy drops below (τ - HYSTERESIS).
//
// State persisted to ~/.apex/state/guardian/domain-sleep.json.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { Domain, DomainStats } from './types';

const HYSTERESIS = 0.05;

// ── Internal persisted state (includes ring buffer not exposed in DomainStats) ─

interface DomainEntry extends DomainStats {
  /** Ring buffer of 0/1 results, up to windowSize length. */
  history: number[];
}

interface SleepStateFile {
  version: number;
  updated_at: string;
  domains: Partial<Record<Domain, DomainEntry>>;
}

// ── DomainSleepTracker ────────────────────────────────────────────────────────

export class DomainSleepTracker {
  private readonly stateFile: string;
  private readonly threshold: number;
  private readonly windowSize: number;
  private state: SleepStateFile;

  constructor(stateDir?: string, threshold = 0.92, windowSize = 20) {
    const dir = stateDir ?? join(homedir(), '.apex', 'state', 'guardian');
    mkdirSync(dir, { recursive: true });
    this.stateFile = join(dir, 'domain-sleep.json');
    this.threshold = threshold;
    this.windowSize = windowSize;
    this.state = this.load();
  }

  /**
   * Record whether the student's response was correct (Guardian approved)
   * or required correction for the given domain.
   */
  record(domain: Domain, wasCorrect: boolean): void {
    const entry = this.getOrCreate(domain);
    const wasAlreadySleeping = entry.in_sleep_mode;

    // Append to ring buffer, evict oldest if at capacity
    entry.history.push(wasCorrect ? 1 : 0);
    if (entry.history.length > this.windowSize) {
      entry.history.shift();
    }

    // Recompute stats from history
    entry.window_size = entry.history.length;
    entry.correct_count = entry.history.reduce((sum, v) => sum + v, 0);
    entry.accuracy = entry.window_size > 0 ? entry.correct_count / entry.window_size : 0;
    entry.last_updated = new Date().toISOString();

    // Enter sleep mode when accuracy reaches threshold for a full window
    if (!wasAlreadySleeping && entry.window_size >= this.windowSize && entry.accuracy >= this.threshold) {
      entry.in_sleep_mode = true;
      entry.sleep_started_at = entry.last_updated;
    }

    // Wake from sleep mode when accuracy drops below hysteresis band
    if (wasAlreadySleeping && entry.accuracy < this.threshold - HYSTERESIS) {
      entry.in_sleep_mode = false;
      entry.sleep_started_at = undefined;
    }

    this.state.domains[domain] = entry;
    this.persist();
  }

  /** Force-wake a domain from sleep mode (called on unexpected errors). */
  wake(domain: Domain): void {
    const entry = this.getOrCreate(domain);
    if (entry.in_sleep_mode) {
      entry.in_sleep_mode = false;
      entry.sleep_started_at = undefined;
      entry.last_updated = new Date().toISOString();
      this.state.domains[domain] = entry;
      this.persist();
    }
  }

  /** Returns true when the Guardian should skip verification for this domain. */
  isSleeping(domain: Domain): boolean {
    return this.state.domains[domain]?.in_sleep_mode ?? false;
  }

  getStats(domain: Domain): DomainStats {
    const { history: _history, ...stats } = this.getOrCreate(domain);
    return stats;
  }

  allStats(): Partial<Record<Domain, DomainStats>> {
    const result: Partial<Record<Domain, DomainStats>> = {};
    for (const [domain, entry] of Object.entries(this.state.domains) as [Domain, DomainEntry][]) {
      const { history: _history, ...stats } = entry;
      result[domain] = stats;
    }
    return result;
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private getOrCreate(domain: Domain): DomainEntry {
    if (!this.state.domains[domain]) {
      this.state.domains[domain] = {
        domain,
        window_size: 0,
        correct_count: 0,
        accuracy: 0,
        in_sleep_mode: false,
        last_updated: new Date().toISOString(),
        history: [],
      };
    }
    return this.state.domains[domain]!;
  }

  private load(): SleepStateFile {
    if (!existsSync(this.stateFile)) {
      return { version: 1, updated_at: new Date().toISOString(), domains: {} };
    }
    try {
      return JSON.parse(readFileSync(this.stateFile, 'utf8')) as SleepStateFile;
    } catch {
      return { version: 1, updated_at: new Date().toISOString(), domains: {} };
    }
  }

  private persist(): void {
    this.state.updated_at = new Date().toISOString();
    writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2), 'utf8');
  }
}
