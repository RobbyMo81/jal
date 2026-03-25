// Co-authored by FORGE (Session: forge-20260325062232-1899997)
// tests/memory/FeedbackStore.test.ts — JAL-008

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { FeedbackStore, PROMOTION_MIN_CONFIDENCE, PROMOTION_MIN_SESSIONS } from '../../src/apex/memory/FeedbackStore';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'apex-feedback-'));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('FeedbackStore', () => {
  let tmpDir: string;
  let store: FeedbackStore;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    store = new FeedbackStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── record / getForItem ───────────────────────────────────────────────────

  describe('record() / getForItem()', () => {
    it('records feedback and retrieves it by item id', () => {
      store.record('item1', 'sess1', 'thumbs-up');
      const records = store.getForItem('item1');
      expect(records).toHaveLength(1);
      expect(records[0]!.feedback).toBe('thumbs-up');
    });

    it('returns empty array for unknown item', () => {
      expect(store.getForItem('ghost')).toHaveLength(0);
    });

    it('replaces existing record for same item+session (idempotency)', () => {
      store.record('item1', 'sess1', 'thumbs-up');
      store.record('item1', 'sess1', 'thumbs-down');
      const records = store.getForItem('item1');
      expect(records).toHaveLength(1);
      expect(records[0]!.feedback).toBe('thumbs-down');
    });

    it('allows feedback from multiple sessions', () => {
      store.record('item1', 'sess1', 'thumbs-up');
      store.record('item1', 'sess2', 'thumbs-up');
      expect(store.getForItem('item1')).toHaveLength(2);
    });
  });

  // ── computeConfidence ─────────────────────────────────────────────────────

  describe('computeConfidence()', () => {
    it('returns 0 when no feedback recorded', () => {
      expect(store.computeConfidence('item1')).toBe(0);
    });

    it('returns 1.0 when all feedback is thumbs-up', () => {
      store.record('item1', 'sess1', 'thumbs-up');
      store.record('item1', 'sess2', 'thumbs-up');
      expect(store.computeConfidence('item1')).toBe(1.0);
    });

    it('returns 0.5 with equal thumbs-up and thumbs-down', () => {
      store.record('item1', 'sess1', 'thumbs-up');
      store.record('item1', 'sess2', 'thumbs-down');
      expect(store.computeConfidence('item1')).toBe(0.5);
    });

    it('computes correctly for 3/4 positive', () => {
      store.record('item1', 'sess1', 'thumbs-up');
      store.record('item1', 'sess2', 'thumbs-up');
      store.record('item1', 'sess3', 'thumbs-up');
      store.record('item1', 'sess4', 'thumbs-down');
      expect(store.computeConfidence('item1')).toBe(0.75);
    });
  });

  // ── positiveSessionCount ──────────────────────────────────────────────────

  describe('positiveSessionCount()', () => {
    it('returns 0 when no positive feedback', () => {
      store.record('item1', 'sess1', 'thumbs-down');
      expect(store.positiveSessionCount('item1')).toBe(0);
    });

    it('counts unique sessions with at least one thumbs-up', () => {
      store.record('item1', 'sess1', 'thumbs-up');
      store.record('item1', 'sess2', 'thumbs-up');
      store.record('item1', 'sess3', 'thumbs-down');
      expect(store.positiveSessionCount('item1')).toBe(2);
    });

    it('does not double-count a session that changed from down to up', () => {
      store.record('item1', 'sess1', 'thumbs-down');
      store.record('item1', 'sess1', 'thumbs-up');  // replaces previous
      expect(store.positiveSessionCount('item1')).toBe(1);
    });
  });

  // ── meetsPromotionCriteria ────────────────────────────────────────────────

  describe('meetsPromotionCriteria()', () => {
    it('returns false when no feedback', () => {
      expect(store.meetsPromotionCriteria('item1')).toBe(false);
    });

    it(`returns false when only 1 session with positive feedback (needs ${PROMOTION_MIN_SESSIONS})`, () => {
      store.record('item1', 'sess1', 'thumbs-up');
      expect(store.meetsPromotionCriteria('item1')).toBe(false);
    });

    it(`returns false when confidence < ${PROMOTION_MIN_CONFIDENCE}`, () => {
      // 2 sessions with positive, but too many negatives
      store.record('item1', 'sess1', 'thumbs-up');
      store.record('item1', 'sess2', 'thumbs-up');
      store.record('item1', 'sess3', 'thumbs-down');
      store.record('item1', 'sess4', 'thumbs-down');
      store.record('item1', 'sess5', 'thumbs-down');
      // confidence = 2/5 = 0.4
      expect(store.meetsPromotionCriteria('item1')).toBe(false);
    });

    it('returns true when both criteria are met', () => {
      store.record('item1', 'sess1', 'thumbs-up');
      store.record('item1', 'sess2', 'thumbs-up');
      // confidence = 2/2 = 1.0, sessions = 2
      expect(store.meetsPromotionCriteria('item1')).toBe(true);
    });

    it(`returns true at exactly confidence = ${PROMOTION_MIN_CONFIDENCE} with 2 sessions`, () => {
      // 4 records: 3 thumbs-up (from 2+ sessions), 1 thumbs-down → confidence = 4/5 = 0.8
      store.record('item1', 'sess1', 'thumbs-up');
      store.record('item1', 'sess2', 'thumbs-up');
      store.record('item1', 'sess3', 'thumbs-up');
      store.record('item1', 'sess4', 'thumbs-down');
      // confidence = 3/4 = 0.75 → FAIL
      expect(store.meetsPromotionCriteria('item1')).toBe(false);
      // Reset and make it 4/5 = 0.80
      const store2 = new FeedbackStore(tmpDir);
      store2.record('item2', 'sess1', 'thumbs-up');
      store2.record('item2', 'sess2', 'thumbs-up');
      store2.record('item2', 'sess3', 'thumbs-up');
      store2.record('item2', 'sess4', 'thumbs-up');
      store2.record('item2', 'sess5', 'thumbs-down');
      // confidence = 4/5 = 0.8 → PASS
      expect(store2.meetsPromotionCriteria('item2')).toBe(true);
    });
  });

  // ── getPromotionCandidates ────────────────────────────────────────────────

  describe('getPromotionCandidates()', () => {
    it('returns only items meeting promotion criteria', () => {
      // item1: meets criteria
      store.record('item1', 'sess1', 'thumbs-up');
      store.record('item1', 'sess2', 'thumbs-up');
      // item2: only 1 session
      store.record('item2', 'sess1', 'thumbs-up');
      // item3: no feedback
      const candidates = store.getPromotionCandidates(['item1', 'item2', 'item3']);
      expect(candidates).toHaveLength(1);
      expect(candidates[0]!.item_id).toBe('item1');
    });
  });

  // ── purge ─────────────────────────────────────────────────────────────────

  describe('purge()', () => {
    it('removes all records for an item', () => {
      store.record('item1', 'sess1', 'thumbs-up');
      store.record('item1', 'sess2', 'thumbs-up');
      store.purge('item1');
      expect(store.getForItem('item1')).toHaveLength(0);
    });

    it('does not affect records for other items', () => {
      store.record('item1', 'sess1', 'thumbs-up');
      store.record('item2', 'sess1', 'thumbs-up');
      store.purge('item1');
      expect(store.getForItem('item2')).toHaveLength(1);
    });
  });
});
