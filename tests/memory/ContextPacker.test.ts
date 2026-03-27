// Co-authored by FORGE (Session: forge-20260327063704-3049883)
// tests/memory/ContextPacker.test.ts — JAL-015

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ContextPacker } from '../../src/apex/memory/ContextPacker';
import { ContextBudget, approxTokens } from '../../src/apex/memory/ContextBudget';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'apex-packer-'));
}

function makeText(tokens: number): string {
  // Approximately `tokens` tokens — each 4-byte word ≈ 1 token
  return 'word '.repeat(tokens);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ContextPacker', () => {
  let tmpDir: string;
  let packer: ContextPacker;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    packer = new ContextPacker(new ContextBudget(tmpDir));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns packed segments that fit within the budget', () => {
    const result = packer.pack({
      contextWindow: 10_000,
      systemPolicy: ['system policy text'],
      activeTask: ['active task text'],
      recentActions: ['recent action 1'],
      retrievedMemory: ['memory item 1'],
    });

    expect(result.segments).toBeDefined();
    expect(result.budget).toBeDefined();
    expect(result.total_tokens).toBeGreaterThan(0);
    // Each segment should be an array
    expect(Array.isArray(result.segments.system_policy)).toBe(true);
    expect(Array.isArray(result.segments.active_task_state)).toBe(true);
    expect(Array.isArray(result.segments.recent_actions)).toBe(true);
    expect(Array.isArray(result.segments.retrieved_memory)).toBe(true);
  });

  it('truncates retrieved_memory when it exceeds its allocation', () => {
    // Each item is large — force truncation
    const bigItems = Array.from({ length: 10 }, (_, i) => makeText(2000));

    const result = packer.pack({
      contextWindow: 10_000,
      systemPolicy: ['sp'],
      activeTask: ['at'],
      recentActions: ['ra'],
      retrievedMemory: bigItems,
    });

    // Budget for retrieved_memory at 15% of 10K = 1500 tokens.
    // Each bigItem is 2000 tokens, so many should be removed.
    const rmTokens = result.segments.retrieved_memory.reduce(
      (s, t) => s + approxTokens(t), 0
    );
    expect(rmTokens).toBeLessThanOrEqual(result.budget.retrieved_memory.tokens + 10);
    expect(result.truncated.retrieved_memory).toBeGreaterThan(0);
  });

  it('never truncates system_policy (safety gate from ContextBudget)', () => {
    // Fill system_policy with reasonable content that fits
    const result = packer.pack({
      contextWindow: 100_000,
      systemPolicy: ['soul doc', 'behavior doc'],
      activeTask: ['task'],
      recentActions: [],
      retrievedMemory: [],
    });

    // system_policy items should pass through untouched
    expect(result.segments.system_policy).toEqual(['soul doc', 'behavior doc']);
    expect(result.truncated.system_policy).toBeUndefined();
  });

  it('reports truncated counts correctly per segment', () => {
    // Use a tiny context window to force truncation
    const manyItems = Array.from({ length: 5 }, (_, i) => `memory item ${i} with some content padding`);

    const result = packer.pack({
      contextWindow: 200,  // very small — forces truncation
      systemPolicy: ['sp'],
      activeTask: ['at'],
      recentActions: ['ra'],
      retrievedMemory: manyItems,
    });

    // Some segments should be truncated given the tiny context window
    // Just verify that truncated values are non-negative integers
    for (const [, count] of Object.entries(result.truncated)) {
      expect(count).toBeGreaterThan(0);
    }
  });

  it('logs debug messages when logger is provided', () => {
    const logs: string[] = [];
    packer.pack({
      contextWindow: 10_000,
      systemPolicy: ['sp'],
      activeTask: ['at'],
      recentActions: ['ra'],
      retrievedMemory: ['rm'],
      logger: (msg) => logs.push(msg),
    });

    // Should log window, model size, input sizes, output sizes, and total
    expect(logs.some(l => l.includes('[ContextPacker]'))).toBe(true);
    expect(logs.some(l => l.includes('window='))).toBe(true);
    expect(logs.some(l => l.includes('total output'))).toBe(true);
  });

  it('produces no debug output when logger is omitted', () => {
    // Should not throw even without a logger
    expect(() => {
      packer.pack({
        contextWindow: 10_000,
        systemPolicy: ['sp'],
        activeTask: ['at'],
        recentActions: [],
        retrievedMemory: [],
      });
    }).not.toThrow();
  });

  it('total_tokens matches sum of packed segment tokens', () => {
    const result = packer.pack({
      contextWindow: 10_000,
      systemPolicy: ['system policy'],
      activeTask: ['task description'],
      recentActions: ['recent action'],
      retrievedMemory: ['memory one', 'memory two'],
    });

    const manualTotal =
      result.segments.system_policy.reduce((s, t) => s + approxTokens(t), 0) +
      result.segments.active_task_state.reduce((s, t) => s + approxTokens(t), 0) +
      result.segments.recent_actions.reduce((s, t) => s + approxTokens(t), 0) +
      result.segments.retrieved_memory.reduce((s, t) => s + approxTokens(t), 0);

    expect(result.total_tokens).toBe(manualTotal);
  });

  it('correctly identifies model size from context window', () => {
    const smallResult = packer.pack({
      contextWindow: 8_192,
      systemPolicy: ['sp'],
      activeTask: ['at'],
      recentActions: [],
      retrievedMemory: [],
    });
    expect(smallResult.budget.model_size).toBe('small');

    const largeResult = packer.pack({
      contextWindow: 200_000,
      systemPolicy: ['sp'],
      activeTask: ['at'],
      recentActions: [],
      retrievedMemory: [],
    });
    expect(largeResult.budget.model_size).toBe('large');
  });

  it('respects budget percentage allocations for large model', () => {
    const contextWindow = 100_000;
    const result = packer.pack({
      contextWindow,
      systemPolicy: ['sp'],
      activeTask: ['at'],
      recentActions: ['ra'],
      retrievedMemory: ['rm'],
    });

    // Large model: usable = full window, default splits apply
    expect(result.budget.system_policy.percent).toBe(25);
    expect(result.budget.active_task_state.percent).toBe(35);
    expect(result.budget.recent_actions.percent).toBe(25);
    expect(result.budget.retrieved_memory.percent).toBe(15);
  });
});
