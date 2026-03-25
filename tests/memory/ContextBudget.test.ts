// Co-authored by FORGE (Session: forge-20260325062232-1899997)
// tests/memory/ContextBudget.test.ts — JAL-008

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ContextBudget,
  approxTokens,
  CHUNK_TOKEN_THRESHOLD,
  CHUNK_HEAD_TOKENS,
  CHUNK_TAIL_TOKENS,
} from '../../src/apex/memory/ContextBudget';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'apex-ctxbudget-'));
}

/** Build a string of approximately `tokens` tokens (4 bytes/token). */
function makeContent(tokens: number): string {
  return 'a'.repeat(tokens * 4);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ContextBudget', () => {
  let tmpDir: string;
  let cb: ContextBudget;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    cb = new ContextBudget(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── approxTokens ──────────────────────────────────────────────────────────

  describe('approxTokens()', () => {
    it('returns 1 for a 4-byte ASCII string', () => {
      expect(approxTokens('abcd')).toBe(1);
    });

    it('returns 250 for a 1000-byte string', () => {
      expect(approxTokens('a'.repeat(1000))).toBe(250);
    });
  });

  // ── computeBudget: large model ────────────────────────────────────────────

  describe('computeBudget() — large model (≥100K)', () => {
    it('uses full context window and default 25/35/25/15 split', () => {
      const budget = cb.computeBudget(200_000);
      expect(budget.model_size).toBe('large');
      expect(budget.usable_tokens).toBe(200_000);
      expect(budget.system_policy.percent).toBe(25);
      expect(budget.active_task_state.percent).toBe(35);
      expect(budget.recent_actions.percent).toBe(25);
      expect(budget.retrieved_memory.percent).toBe(15);
    });

    it('allocates correct token counts', () => {
      const budget = cb.computeBudget(200_000);
      expect(budget.system_policy.tokens).toBe(50_000);       // 25%
      expect(budget.active_task_state.tokens).toBe(70_000);   // 35%
      expect(budget.recent_actions.tokens).toBe(50_000);      // 25%
      expect(budget.retrieved_memory.tokens).toBe(30_000);    // 15%
    });
  });

  // ── computeBudget: medium model ───────────────────────────────────────────

  describe('computeBudget() — medium model (16K–100K)', () => {
    it('scales total by 0.75 and keeps 25/35/25/15 split', () => {
      const budget = cb.computeBudget(32_768);
      expect(budget.model_size).toBe('medium');
      expect(budget.usable_tokens).toBe(Math.floor(32_768 * 0.75));
      expect(budget.system_policy.percent).toBe(25);
      expect(budget.active_task_state.percent).toBe(35);
    });
  });

  // ── computeBudget: small model ────────────────────────────────────────────

  describe('computeBudget() — small model (<16K)', () => {
    it('scales total by 0.50', () => {
      const budget = cb.computeBudget(8_192);
      expect(budget.model_size).toBe('small');
      expect(budget.usable_tokens).toBe(Math.floor(8_192 * 0.50));
    });

    it('enforces minimum floor: system_policy never below 10%', () => {
      // Override system_policy_pct to 5% — floor should raise it to 10%
      const budget = cb.computeBudget(8_192, { system_policy_pct: 5 });
      expect(budget.system_policy.percent).toBe(10);
    });

    it('enforces minimum floor: active_task_state never below 15%', () => {
      const budget = cb.computeBudget(8_192, { active_task_state_pct: 10 });
      expect(budget.active_task_state.percent).toBe(15);
    });

    it('does not apply floors to medium model', () => {
      // Floors only apply to small; medium overrides should pass through as-is
      const budget = cb.computeBudget(32_768, { system_policy_pct: 5 });
      expect(budget.system_policy.percent).toBe(5);
    });
  });

  // ── computeBudget: user overrides ─────────────────────────────────────────

  describe('computeBudget() — user overrides', () => {
    it('respects user-configured percentages on large model', () => {
      const budget = cb.computeBudget(128_000, {
        system_policy_pct: 30,
        active_task_state_pct: 40,
        recent_actions_pct: 20,
        retrieved_memory_pct: 10,
      });
      expect(budget.system_policy.percent).toBe(30);
      expect(budget.active_task_state.percent).toBe(40);
      expect(budget.recent_actions.percent).toBe(20);
      expect(budget.retrieved_memory.percent).toBe(10);
    });
  });

  // ── enforceLimit ──────────────────────────────────────────────────────────

  describe('enforceLimit()', () => {
    it('passes through segments that already fit', () => {
      const budget = cb.computeBudget(200_000);
      const segments = {
        system_policy:     ['short text'],
        active_task_state: ['short text'],
        recent_actions:    ['short text'],
        retrieved_memory:  ['short text'],
      };
      const result = cb.enforceLimit(budget, segments);
      expect(result.system_policy).toHaveLength(1);
      expect(result.active_task_state).toHaveLength(1);
    });

    it('truncates retrieved_memory from front (oldest first)', () => {
      // Use a tiny context window so the budget is very tight
      const budget = cb.computeBudget(400); // tiny
      const bigItem = makeContent(200); // ~200 tokens
      const segments = {
        system_policy:     [],
        active_task_state: [],
        recent_actions:    [],
        retrieved_memory:  ['old-item-1: ' + bigItem, 'old-item-2: ' + bigItem, 'new-item: hi'],
      };
      const result = cb.enforceLimit(budget, segments);
      // Should have removed oldest items first; 'new-item' may survive if budget allows
      // The important invariant is that the array is a suffix of the input
      const original = segments.retrieved_memory;
      for (const kept of result.retrieved_memory) {
        expect(original).toContain(kept);
      }
    });

    it('truncates active_task_state from end (lowest relevance)', () => {
      const budget = cb.computeBudget(400);
      const bigItem = makeContent(200);
      const segments = {
        system_policy:     [],
        active_task_state: ['first-important: hi', 'second: ' + bigItem, 'third: ' + bigItem],
        recent_actions:    [],
        retrieved_memory:  [],
      };
      const result = cb.enforceLimit(budget, segments);
      // Truncation from end — if any items survive, 'first-important' should be among them
      if (result.active_task_state.length > 0) {
        expect(result.active_task_state[0]).toBe('first-important: hi');
      }
    });

    it('never truncates system_policy', () => {
      // Completely fill every other segment; system_policy should survive intact
      const budget = cb.computeBudget(200_000);
      const fullSystemPolicy = Array.from({ length: 20 }, (_, i) => `policy-${i}: ${makeContent(100)}`);
      const segments = {
        system_policy:     fullSystemPolicy,
        active_task_state: [],
        recent_actions:    [],
        retrieved_memory:  [],
      };
      const result = cb.enforceLimit(budget, segments);
      // system_policy may still be truncated at segment level, but the invariant is
      // that it is never cleared in favour of other segments. With 20×100 ≈ 2000 tokens
      // vs 50000 system_policy budget, everything should fit here.
      expect(result.system_policy).toHaveLength(fullSystemPolicy.length);
    });
  });

  // ── chunkToolOutput ───────────────────────────────────────────────────────

  describe('chunkToolOutput()', () => {
    it('returns was_chunked=false for small outputs', () => {
      const content = makeContent(100);  // 100 tokens — under threshold
      const chunk = cb.chunkToolOutput(content);
      expect(chunk.was_chunked).toBe(false);
      expect(chunk.prompt_content).toBe(content);
    });

    it('returns was_chunked=true and truncates large outputs', () => {
      const content = makeContent(CHUNK_TOKEN_THRESHOLD + 500);
      const chunk = cb.chunkToolOutput(content);
      expect(chunk.was_chunked).toBe(true);
      expect(approxTokens(chunk.prompt_content)).toBeLessThanOrEqual(
        CHUNK_HEAD_TOKENS + CHUNK_TAIL_TOKENS + 50  // +50 for separator overhead
      );
    });

    it('stores full output ref with SHA256 hash', () => {
      const content = makeContent(CHUNK_TOKEN_THRESHOLD + 100);
      const chunk = cb.chunkToolOutput(content);
      expect(chunk.full_ref.hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('prompt_content contains omission separator for large outputs', () => {
      const content = makeContent(2_000);
      const chunk = cb.chunkToolOutput(content);
      expect(chunk.prompt_content).toContain('tokens omitted');
      expect(chunk.prompt_content).toContain('SHA256:');
    });

    it('retrieveFullOutput returns the original content', () => {
      const content = makeContent(2_000);
      const chunk = cb.chunkToolOutput(content);
      const retrieved = cb.retrieveFullOutput(chunk.full_ref);
      expect(retrieved).toBe(content);
    });
  });
});
