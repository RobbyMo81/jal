// Co-authored by FORGE (Session: forge-20260325062232-1899997)
// tests/memory/MemoryManager.test.ts — JAL-008

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MemoryManager } from '../../src/apex/memory/MemoryManager';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'apex-mm-'));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MemoryManager', () => {
  let tmpDir: string;
  let mm: MemoryManager;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    mm = new MemoryManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Short-term ────────────────────────────────────────────────────────────

  describe('short-term tier', () => {
    it('adds and retrieves short-term items', () => {
      const item = mm.addShortTerm('note', ['task'], 'ws1', 'sess1');
      const result = mm.getShortTerm(item.id);
      expect(result).not.toBeNull();
      expect(result!.content).toBe('note');
    });

    it('returns null for unknown short-term id', () => {
      expect(mm.getShortTerm('ghost')).toBeNull();
    });

    it('clearShortTerm removes all short-term items', () => {
      mm.addShortTerm('a', [], 'ws1', 'sess1');
      mm.addShortTerm('b', [], 'ws1', 'sess1');
      mm.clearShortTerm();
      expect(mm.listShortTerm()).toHaveLength(0);
    });

    it('short-term items are not persisted to disk', () => {
      mm.addShortTerm('ephemeral', [], 'ws1', 'sess1');
      const mm2 = new MemoryManager(tmpDir);
      expect(mm2.listShortTerm()).toHaveLength(0);
    });
  });

  // ── Episodic ──────────────────────────────────────────────────────────────

  describe('episodic tier', () => {
    it('adds and retrieves episodic items', () => {
      const item = mm.addEpisodic('context note', ['ctx'], 'ws1', 'sess1');
      const result = mm.getEpisodic('ws1', item.id);
      expect(result).not.toBeNull();
      expect(result!.content).toBe('context note');
    });

    it('finds episodic items by tag', () => {
      mm.addEpisodic('a', ['tag1'], 'ws1', 'sess1');
      mm.addEpisodic('b', ['tag2'], 'ws1', 'sess1');
      const results = mm.findEpisodicByTag('ws1', 'tag1');
      expect(results).toHaveLength(1);
      expect(results[0]!.content).toBe('a');
    });

    it('lists episodic items in a workspace', () => {
      mm.addEpisodic('x', [], 'ws1', 'sess1');
      mm.addEpisodic('y', [], 'ws1', 'sess1');
      expect(mm.listEpisodic('ws1')).toHaveLength(2);
    });
  });

  // ── Feedback + promotion ──────────────────────────────────────────────────

  describe('feedback and promotion', () => {
    it('records user feedback and computes confidence', () => {
      const item = mm.addEpisodic('useful', [], 'ws1', 'sess1');
      mm.recordFeedback(item.id, 'sess1', 'thumbs-up');
      mm.recordFeedback(item.id, 'sess2', 'thumbs-up');
      expect(mm.getConfidence(item.id)).toBe(1.0);
    });

    it('getPromotionCandidates returns items meeting criteria', () => {
      const item = mm.addEpisodic('promo-candidate', [], 'ws1', 'sess1');
      mm.recordFeedback(item.id, 'sess1', 'thumbs-up');
      mm.recordFeedback(item.id, 'sess2', 'thumbs-up');
      const candidates = mm.getPromotionCandidates('ws1');
      expect(candidates.map(c => c.item_id)).toContain(item.id);
    });

    it('getPromotionCandidates excludes already-durable items', () => {
      const item = mm.addEpisodic('already-promoted', [], 'ws1', 'sess1');
      mm.recordFeedback(item.id, 'sess1', 'thumbs-up');
      mm.recordFeedback(item.id, 'sess2', 'thumbs-up');
      // Promote with approval
      mm.promoteToDurable('ws1', item.id, true);
      // Should no longer be a candidate
      const candidates = mm.getPromotionCandidates('ws1');
      expect(candidates.map(c => c.item_id)).not.toContain(item.id);
    });

    it('SAFETY GATE: promoteToDurable throws when userApproved=false', () => {
      const item = mm.addEpisodic('no-auto', [], 'ws1', 'sess1');
      mm.recordFeedback(item.id, 'sess1', 'thumbs-up');
      mm.recordFeedback(item.id, 'sess2', 'thumbs-up');
      expect(() => mm.promoteToDurable('ws1', item.id, false)).toThrow('SAFETY GATE');
    });

    it('promoteToDurable throws when criteria not met', () => {
      const item = mm.addEpisodic('not-ready', [], 'ws1', 'sess1');
      mm.recordFeedback(item.id, 'sess1', 'thumbs-up'); // only 1 session
      expect(() => mm.promoteToDurable('ws1', item.id, true)).toThrow('does not meet promotion criteria');
    });

    it('promoted item appears in durable and not episodic', () => {
      const item = mm.addEpisodic('will-be-durable', ['x'], 'ws1', 'sess1');
      mm.recordFeedback(item.id, 'sess1', 'thumbs-up');
      mm.recordFeedback(item.id, 'sess2', 'thumbs-up');
      const promoted = mm.promoteToDurable('ws1', item.id, true);
      expect(promoted.tier).toBe('durable');
      expect(mm.listDurable().map(i => i.id)).toContain(item.id);
      expect(mm.listEpisodic('ws1').map(i => i.id)).not.toContain(item.id);
    });
  });

  // ── Cross-tier findByTag ───────────────────────────────────────────────────

  describe('findByTag() cross-tier', () => {
    it('returns matches from durable, episodic, and short-term', () => {
      mm.addShortTerm('st-item', ['shared'], 'ws1', 'sess1');
      mm.addEpisodic('ep-item', ['shared'], 'ws1', 'sess1');
      const results = mm.findByTag('ws1', 'shared');
      const contents = results.map(r => r.content);
      expect(contents).toContain('st-item');
      expect(contents).toContain('ep-item');
    });
  });
});
