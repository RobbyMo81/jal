// Co-authored by FORGE (Session: forge-20260325062232-1899997)
// src/apex/memory/FeedbackStore.ts — JAL-008 User Feedback & Promotion Candidates
//
// Tracks explicit user feedback (thumbs-up / thumbs-down) for episodic items.
// Confidence scoring is purely user-feedback-driven — never LLM-determined.
//
// Promotion to durable requires ALL THREE:
//   1. Usefulness across ≥2 independent sessions (sessions with ≥1 thumbs-up)
//   2. Confidence score ≥0.8 (positive_feedback / total_feedback)
//   3. Explicit user approval (enforced in MemoryManager.promoteToDurable)
//
// Storage: ~/.apex/state/memory/feedback.json (atomic writes)

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FeedbackFile, MemoryFeedbackRecord, PromotionCandidate, UserFeedback } from '../types';

// ── Constants ─────────────────────────────────────────────────────────────────

export const PROMOTION_MIN_SESSIONS = 2;
export const PROMOTION_MIN_CONFIDENCE = 0.8;

// ── FeedbackStore ─────────────────────────────────────────────────────────────

export class FeedbackStore {
  private readonly filePath: string;

  constructor(stateDir?: string) {
    const base = stateDir ?? path.join(os.homedir(), '.apex', 'state');
    const dir = path.join(base, 'memory');
    this.filePath = path.join(dir, 'feedback.json');
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  private ensureDir(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  private atomicWrite(content: string): void {
    this.ensureDir();
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, this.filePath);
  }

  private loadFile(): FeedbackFile {
    if (!fs.existsSync(this.filePath)) {
      return { version: 1, updated_at: new Date().toISOString(), records: [] };
    }
    return JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as FeedbackFile;
  }

  private saveFile(file: FeedbackFile): void {
    file.updated_at = new Date().toISOString();
    this.atomicWrite(JSON.stringify(file, null, 2));
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Record a single user feedback event for a memory item.
   * One session may submit multiple feedback events (last one overrides
   * the earlier one for the same item+session pair to prevent ballot-stuffing).
   */
  record(itemId: string, sessionId: string, feedback: UserFeedback, now: Date = new Date()): void {
    const file = this.loadFile();

    // Idempotent: replace existing record for same item+session pair
    const existing = file.records.findIndex(r => r.item_id === itemId && r.session_id === sessionId);
    const entry: MemoryFeedbackRecord = {
      item_id: itemId,
      session_id: sessionId,
      feedback,
      timestamp: now.toISOString(),
    };
    if (existing >= 0) {
      file.records[existing] = entry;
    } else {
      file.records.push(entry);
    }
    this.saveFile(file);
  }

  /**
   * Return all feedback records for a given item.
   */
  getForItem(itemId: string): MemoryFeedbackRecord[] {
    return this.loadFile().records.filter(r => r.item_id === itemId);
  }

  /**
   * Compute the confidence score for an item:
   *   positive_feedback_count / total_feedback_count
   * Returns 0 when no feedback has been recorded.
   */
  computeConfidence(itemId: string): number {
    const records = this.getForItem(itemId);
    if (records.length === 0) return 0;
    const positive = records.filter(r => r.feedback === 'thumbs-up').length;
    return positive / records.length;
  }

  /**
   * Number of unique sessions that gave this item at least one thumbs-up.
   */
  positiveSessionCount(itemId: string): number {
    const records = this.getForItem(itemId);
    const sessions = new Set<string>();
    for (const r of records) {
      if (r.feedback === 'thumbs-up') sessions.add(r.session_id);
    }
    return sessions.size;
  }

  /**
   * Check whether an item meets the quantitative promotion criteria:
   *   - ≥2 sessions with positive feedback
   *   - confidence ≥0.8
   * Does NOT check for user approval (that is enforced in MemoryManager).
   */
  meetsPromotionCriteria(itemId: string): boolean {
    return (
      this.positiveSessionCount(itemId) >= PROMOTION_MIN_SESSIONS &&
      this.computeConfidence(itemId) >= PROMOTION_MIN_CONFIDENCE
    );
  }

  /**
   * Build a PromotionCandidate record for an item.
   * Returns null if the item has never received feedback.
   */
  buildCandidate(itemId: string): PromotionCandidate | null {
    const records = this.getForItem(itemId);
    if (records.length === 0) return null;
    const positive = records.filter(r => r.feedback === 'thumbs-up').length;
    return {
      item_id: itemId,
      session_count: this.positiveSessionCount(itemId),
      confidence_score: positive / records.length,
      total_feedback: records.length,
      positive_feedback: positive,
    };
  }

  /**
   * Given a list of episodic item IDs, return those that meet all
   * quantitative promotion criteria as PromotionCandidate objects.
   * Caller is responsible for filtering out already-promoted items.
   */
  getPromotionCandidates(itemIds: string[]): PromotionCandidate[] {
    return itemIds
      .filter(id => this.meetsPromotionCriteria(id))
      .map(id => this.buildCandidate(id))
      .filter((c): c is PromotionCandidate => c !== null);
  }

  /**
   * Remove all feedback records for a given item (e.g. after durable promotion or eviction).
   */
  purge(itemId: string): void {
    const file = this.loadFile();
    file.records = file.records.filter(r => r.item_id !== itemId);
    this.saveFile(file);
  }
}
