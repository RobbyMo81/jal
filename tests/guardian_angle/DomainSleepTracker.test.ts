// Co-authored by Apex Wakening Build
// tests/guardian_angle/DomainSleepTracker.test.ts — DomainSleepTracker unit tests

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DomainSleepTracker } from '../../src/apex/guardian_angle/DomainSleepTracker';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'apex-sleep-test-'));
}

// ── basic record / accuracy tracking ─────────────────────────────────────────

describe('DomainSleepTracker accuracy tracking', () => {
  let dir: string;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => rmSync(dir, { recursive: true }));

  it('starts with zero accuracy for new domain', () => {
    const tracker = new DomainSleepTracker(dir, 0.9, 5);
    const stats = tracker.getStats('general');
    expect(stats.accuracy).toBe(0);
    expect(stats.in_sleep_mode).toBe(false);
  });

  it('tracks accuracy over interactions', () => {
    const tracker = new DomainSleepTracker(dir, 0.9, 4);
    tracker.record('reasoning', true);
    tracker.record('reasoning', true);
    tracker.record('reasoning', true);
    tracker.record('reasoning', false);

    const stats = tracker.getStats('reasoning');
    expect(stats.window_size).toBe(4);
    expect(stats.correct_count).toBe(3);
    expect(stats.accuracy).toBe(0.75);
  });

  it('does not enter sleep mode before full window', () => {
    const tracker = new DomainSleepTracker(dir, 0.9, 10);
    for (let i = 0; i < 9; i++) tracker.record('general', true);
    expect(tracker.isSleeping('general')).toBe(false);
  });
});

// ── sleep mode entry ──────────────────────────────────────────────────────────

describe('DomainSleepTracker sleep mode', () => {
  let dir: string;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => rmSync(dir, { recursive: true }));

  it('enters sleep mode when accuracy >= threshold for full window', () => {
    const tracker = new DomainSleepTracker(dir, 0.9, 5);
    for (let i = 0; i < 5; i++) tracker.record('code_generation', true);
    expect(tracker.isSleeping('code_generation')).toBe(true);
    expect(tracker.getStats('code_generation').sleep_started_at).toBeDefined();
  });

  it('does not enter sleep mode if accuracy < threshold', () => {
    const tracker = new DomainSleepTracker(dir, 0.9, 4);
    tracker.record('general', true);
    tracker.record('general', false);
    tracker.record('general', true);
    tracker.record('general', true);
    // accuracy = 3/4 = 0.75 < 0.9
    expect(tracker.isSleeping('general')).toBe(false);
  });

  it('force-wake removes sleep mode', () => {
    const tracker = new DomainSleepTracker(dir, 0.9, 3);
    for (let i = 0; i < 3; i++) tracker.record('reasoning', true);
    expect(tracker.isSleeping('reasoning')).toBe(true);
    tracker.wake('reasoning');
    expect(tracker.isSleeping('reasoning')).toBe(false);
    expect(tracker.getStats('reasoning').sleep_started_at).toBeUndefined();
  });

  it('wake is no-op on non-sleeping domain', () => {
    const tracker = new DomainSleepTracker(dir, 0.9, 5);
    expect(() => tracker.wake('shell_commands')).not.toThrow();
    expect(tracker.isSleeping('shell_commands')).toBe(false);
  });
});

// ── persistence ───────────────────────────────────────────────────────────────

describe('DomainSleepTracker persistence', () => {
  let dir: string;
  beforeEach(() => { dir = makeTmpDir(); });
  afterEach(() => rmSync(dir, { recursive: true }));

  it('persists and restores state across instances', () => {
    const t1 = new DomainSleepTracker(dir, 0.9, 3);
    for (let i = 0; i < 3; i++) t1.record('file_operations', true);
    expect(t1.isSleeping('file_operations')).toBe(true);

    const t2 = new DomainSleepTracker(dir, 0.9, 3);
    expect(t2.isSleeping('file_operations')).toBe(true);
    expect(t2.getStats('file_operations').accuracy).toBe(1);
  });

  it('returns empty stats for unknown domain after reload', () => {
    const t1 = new DomainSleepTracker(dir, 0.9, 5);
    t1.record('general', true);

    const t2 = new DomainSleepTracker(dir, 0.9, 5);
    const stats = t2.getStats('reasoning');
    expect(stats.window_size).toBe(0);
  });
});
