// Co-authored by FORGE (Session: forge-20260327063704-3049883)
// tests/memory/RelevanceScorer.test.ts — JAL-015

import { RelevanceScorer, KEYWORD_WEIGHT, RECENCY_WEIGHT, DEFAULT_TOP_K } from '../../src/apex/memory/RelevanceScorer';
import { MemoryItem } from '../../src/apex/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

let idCounter = 0;

function makeItem(content: string, overrides: Partial<MemoryItem> = {}): MemoryItem {
  idCounter++;
  const now = new Date().toISOString();
  return {
    id: `item-${idCounter}`,
    tier: 'episodic',
    content,
    tags: [],
    workspace_id: 'ws1',
    session_id: 'sess1',
    created_at: now,
    last_accessed_at: now,
    access_count: 0,
    size_bytes: Buffer.byteLength(content, 'utf8'),
    ...overrides,
  };
}

function makeItemWithAge(content: string, ageDays: number): MemoryItem {
  idCounter++;
  const now = new Date();
  const accessedAt = new Date(now.getTime() - ageDays * 24 * 60 * 60 * 1000);
  return {
    id: `item-${idCounter}`,
    tier: 'episodic',
    content,
    tags: [],
    workspace_id: 'ws1',
    session_id: 'sess1',
    created_at: accessedAt.toISOString(),
    last_accessed_at: accessedAt.toISOString(),
    access_count: 0,
    size_bytes: Buffer.byteLength(content, 'utf8'),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => { idCounter = 0; });

describe('RelevanceScorer.tokenize', () => {
  it('lowercases and splits on non-word characters', () => {
    expect(RelevanceScorer.tokenize('Hello World')).toEqual(['hello', 'world']);
    expect(RelevanceScorer.tokenize('foo-bar_baz.qux')).toEqual(expect.arrayContaining(['foo', 'bar', 'baz', 'qux']));
  });

  it('excludes stop words', () => {
    const tokens = RelevanceScorer.tokenize('the quick brown fox');
    expect(tokens).not.toContain('the');
    expect(tokens).toContain('quick');
    expect(tokens).toContain('brown');
    expect(tokens).toContain('fox');
  });

  it('excludes tokens shorter than 2 characters', () => {
    const tokens = RelevanceScorer.tokenize('a b cd ef');
    expect(tokens).not.toContain('a');
    expect(tokens).not.toContain('b');
    expect(tokens).toContain('cd');
    expect(tokens).toContain('ef');
  });

  it('is deterministic — same input always produces same output', () => {
    const input = 'Deploy the Docker container to production';
    expect(RelevanceScorer.tokenize(input)).toEqual(RelevanceScorer.tokenize(input));
  });
});

describe('RelevanceScorer.buildKeywordIndex', () => {
  const scorer = new RelevanceScorer();

  it('returns a frequency map of non-stop, non-short tokens', () => {
    const idx = scorer.buildKeywordIndex('deploy docker deploy');
    expect(idx.get('deploy')).toBe(2);
    expect(idx.get('docker')).toBe(1);
    expect(idx.has('the')).toBe(false);
  });

  it('returns empty map for stop-word-only input', () => {
    const idx = scorer.buildKeywordIndex('the and or');
    expect(idx.size).toBe(0);
  });
});

describe('RelevanceScorer.scoreItem', () => {
  const scorer = new RelevanceScorer();
  const now = new Date('2026-01-15T12:00:00Z');

  it('returns 0 for empty keyword index', () => {
    const idx = new Map<string, number>();
    const item = makeItem('deploy docker container');
    const score = scorer.scoreItem(idx, item, now);
    // keyword=0, recency depends on item age (item is ~just now)
    expect(score).toBeLessThan(RECENCY_WEIGHT + 0.01);
  });

  it('scores high when item content matches goal keywords', () => {
    const idx = scorer.buildKeywordIndex('deploy docker container');
    const matching = makeItem('docker container deployment steps');
    const nonMatching = makeItem('cooking recipes pasta');
    const scoreMatch = scorer.scoreItem(idx, matching, now);
    const scoreNon = scorer.scoreItem(idx, nonMatching, now);
    expect(scoreMatch).toBeGreaterThan(scoreNon);
  });

  it('scores pure recency correctly for items with no keyword overlap', () => {
    const idx = scorer.buildKeywordIndex('unrelated goal xyz');
    // Recent item: 0 days old
    const recent = makeItemWithAge('completely unrelated content', 0);
    // Old item: 30 days old
    const old = makeItemWithAge('completely unrelated content', 30);

    const scoreRecent = scorer.scoreItem(idx, recent, new Date());
    const scoreOld = scorer.scoreItem(idx, old, new Date());

    // Both have 0 keyword overlap; recent should score higher due to recency
    expect(scoreRecent).toBeGreaterThan(scoreOld);
  });

  it('score components sum to correct weighted value', () => {
    // Build item with perfect keyword overlap and 0 age
    const goal = 'deploy docker container';
    const idx = scorer.buildKeywordIndex(goal);
    const item = makeItem('deploy docker container'); // 3/3 unique goal keywords match

    // Score with reference time = item's last_accessed_at for 0-age recency
    const refTime = new Date(item.last_accessed_at);
    const score = scorer.scoreItem(idx, item, refTime);

    // keyword overlap = 1.0, recency = 1/(1+0) = 1.0
    const expected = KEYWORD_WEIGHT * 1.0 + RECENCY_WEIGHT * 1.0;
    expect(score).toBeCloseTo(expected, 3);
  });

  it('caps keyword overlap at 1.0', () => {
    const idx = scorer.buildKeywordIndex('a b c');  // may be all stop words — use real words
    const idx2 = scorer.buildKeywordIndex('cat dog fish');
    const item = makeItem('cat dog fish bird elephant');
    const score = scorer.scoreItem(idx2, item, now);
    // All 3 goal keywords present → overlap = 1.0
    expect(score).toBeCloseTo(KEYWORD_WEIGHT * 1.0 + RECENCY_WEIGHT * scorer.scoreItem(new Map([['x', 1]]), item, now) / 1, 0);
    // Simpler: just assert score <= 1.0
    expect(score).toBeLessThanOrEqual(1.0 + 0.001);
  });
});

describe('RelevanceScorer.selectTopK', () => {
  const scorer = new RelevanceScorer();

  it('returns at most K items', () => {
    const items = Array.from({ length: 20 }, (_, i) => makeItem(`item content ${i}`));
    const result = scorer.selectTopK('some goal', items, 5);
    expect(result.length).toBeLessThanOrEqual(5);
  });

  it('uses DEFAULT_TOP_K when k is not specified', () => {
    const items = Array.from({ length: 30 }, (_, i) => makeItem(`content ${i}`));
    const result = scorer.selectTopK('some goal', items);
    expect(result.length).toBeLessThanOrEqual(DEFAULT_TOP_K);
  });

  it('ranks more relevant items higher', () => {
    const goal = 'deploy docker container to production';
    const relevant = makeItem('docker container deployment production steps');
    const irrelevant = makeItem('baking bread flour yeast water');
    const items = [irrelevant, relevant];

    const result = scorer.selectTopK(goal, items, 2);
    expect(result[0]!.id).toBe(relevant.id);
  });

  it('SAFETY GATE: never returns items with sensitive === true', () => {
    const sensitive = makeItem('docker secrets production credentials', { sensitive: true });
    const normal = makeItem('docker deployment steps');

    const result = scorer.selectTopK('deploy docker', [sensitive, normal], 10);
    expect(result.every(r => r.sensitive !== true)).toBe(true);
    expect(result.map(r => r.id)).not.toContain(sensitive.id);
  });

  it('returns empty array when all items are sensitive', () => {
    const items = [
      makeItem('content a', { sensitive: true }),
      makeItem('content b', { sensitive: true }),
    ];
    const result = scorer.selectTopK('any goal', items, 10);
    expect(result).toHaveLength(0);
  });

  it('returns empty array for empty input', () => {
    expect(scorer.selectTopK('goal', [], 10)).toHaveLength(0);
  });

  it('handles goal with only stop words gracefully', () => {
    // All goal tokens are stop words → keyword index is empty → all items score only by recency
    const items = [makeItem('some content'), makeItem('other content')];
    const result = scorer.selectTopK('the and or', items, 10);
    expect(result.length).toBe(2); // both returned, ranked by recency only
  });

  it('is deterministic — same inputs produce same order', () => {
    const items = Array.from({ length: 5 }, (_, i) => makeItemWithAge(`deploy docker step ${i}`, i));
    const r1 = scorer.selectTopK('deploy docker', items, 5, new Date('2026-01-15T12:00:00Z'));
    const r2 = scorer.selectTopK('deploy docker', items, 5, new Date('2026-01-15T12:00:00Z'));
    expect(r1.map(i => i.id)).toEqual(r2.map(i => i.id));
  });
});
