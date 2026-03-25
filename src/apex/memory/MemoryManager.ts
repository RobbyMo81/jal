// Co-authored by FORGE (Session: forge-20260325062232-1899997)
// src/apex/memory/MemoryManager.ts — JAL-008 Three-Tier Memory Orchestration
//
// Orchestrates short-term (in-memory), episodic (file-backed, TTL+LRU), and
// durable (file-backed, requires explicit user approval) memory tiers.
//
// SHORT-TERM  — lives only for the current active task (cleared on task end)
// EPISODIC    — 30-day TTL, 50 MB LRU quota, per-workspace
// DURABLE     — explicit user approval gate; never auto-promoted
//
// Promotion path: episodic → (criteria check) → candidate → (user approves) → durable

import * as crypto from 'crypto';
import { EpisodicStore } from './EpisodicStore';
import { DurableStore } from './DurableStore';
import { FeedbackStore } from './FeedbackStore';
import { MemoryItem, MemoryTier, PromotionCandidate, UserFeedback } from '../types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function newId(): string {
  return crypto.randomUUID();
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeItem(
  content: string,
  tags: string[],
  workspaceId: string,
  sessionId: string,
  tier: MemoryTier,
): MemoryItem {
  const now = nowIso();
  return {
    id: newId(),
    tier,
    content,
    tags,
    workspace_id: workspaceId,
    session_id: sessionId,
    created_at: now,
    last_accessed_at: now,
    access_count: 0,
    size_bytes: Buffer.byteLength(content, 'utf8'),
  };
}

// ── MemoryManager ─────────────────────────────────────────────────────────────

export class MemoryManager {
  /** Short-term: in-memory only, cleared when task ends. */
  private readonly shortTerm: Map<string, MemoryItem> = new Map();

  private readonly episodic: EpisodicStore;
  private readonly durable: DurableStore;
  private readonly feedback: FeedbackStore;

  constructor(stateDir?: string) {
    this.episodic = new EpisodicStore(stateDir);
    this.durable = new DurableStore(stateDir);
    this.feedback = new FeedbackStore(stateDir);
  }

  // ── Short-term ─────────────────────────────────────────────────────────────

  /**
   * Add an item to short-term memory.
   * Short-term items are never persisted to disk and do not survive process restart.
   */
  addShortTerm(content: string, tags: string[], workspaceId: string, sessionId: string): MemoryItem {
    const item = makeItem(content, tags, workspaceId, sessionId, 'short-term');
    this.shortTerm.set(item.id, item);
    return item;
  }

  /**
   * Retrieve a short-term item by ID.  Returns null if not present.
   */
  getShortTerm(itemId: string): MemoryItem | null {
    const item = this.shortTerm.get(itemId);
    if (!item) return null;
    item.last_accessed_at = nowIso();
    item.access_count += 1;
    return item;
  }

  /**
   * Return all current short-term items.
   */
  listShortTerm(): MemoryItem[] {
    return Array.from(this.shortTerm.values());
  }

  /**
   * Clear all short-term items.  Call this when the active task ends.
   */
  clearShortTerm(): void {
    this.shortTerm.clear();
  }

  // ── Episodic ───────────────────────────────────────────────────────────────

  /**
   * Add an item to episodic memory and run eviction if needed.
   */
  addEpisodic(content: string, tags: string[], workspaceId: string, sessionId: string): MemoryItem {
    const item = makeItem(content, tags, workspaceId, sessionId, 'episodic');
    this.episodic.store(item);
    return item;
  }

  /**
   * Retrieve an episodic item by ID (touches TTL).
   */
  getEpisodic(workspaceId: string, itemId: string): MemoryItem | null {
    return this.episodic.get(workspaceId, itemId);
  }

  /**
   * Find episodic items by tag.
   */
  findEpisodicByTag(workspaceId: string, tag: string): MemoryItem[] {
    return this.episodic.findByTag(workspaceId, tag);
  }

  /**
   * List all non-expired episodic items in a workspace.
   */
  listEpisodic(workspaceId: string): MemoryItem[] {
    return this.episodic.list(workspaceId);
  }

  // ── Durable ────────────────────────────────────────────────────────────────

  /**
   * Find durable items by tag.
   */
  findDurableByTag(tag: string): MemoryItem[] {
    return this.durable.findByTag(tag);
  }

  /**
   * List all durable items.
   */
  listDurable(): MemoryItem[] {
    return this.durable.list();
  }

  // ── Feedback ───────────────────────────────────────────────────────────────

  /**
   * Record explicit user feedback for a memory item (thumbs-up / thumbs-down).
   * Confidence scoring is computed from these records only — never LLM-determined.
   */
  recordFeedback(itemId: string, sessionId: string, feedback: UserFeedback): void {
    this.feedback.record(itemId, sessionId, feedback);
  }

  /**
   * Return the confidence score for a memory item.
   */
  getConfidence(itemId: string): number {
    return this.feedback.computeConfidence(itemId);
  }

  // ── Promotion ──────────────────────────────────────────────────────────────

  /**
   * Return the list of episodic items in a workspace that meet all quantitative
   * promotion criteria (≥2 positive-feedback sessions, confidence ≥0.8) and are
   * not already in durable storage.
   *
   * Candidates are surfaced for operator review.  No auto-promotion occurs.
   */
  getPromotionCandidates(workspaceId: string): PromotionCandidate[] {
    const episodicIds = this.episodic.list(workspaceId).map(i => i.id);
    // Only candidates not already promoted
    const unpromoted = episodicIds.filter(id => !this.durable.has(id));
    return this.feedback.getPromotionCandidates(unpromoted);
  }

  /**
   * Promote an episodic item to durable storage.
   *
   * SAFETY GATE: userApproved MUST be true.  This is the single gate that prevents
   * auto-promotion.  Callers obtain this flag through explicit operator input only
   * (Phase 2 UI or direct operator call).
   *
   * @throws Error if userApproved is false, item is not in episodic store, or criteria not met.
   */
  promoteToDurable(workspaceId: string, itemId: string, userApproved: boolean): MemoryItem {
    if (!userApproved) {
      throw new Error(`SAFETY GATE: durable promotion of ${itemId} requires explicit user approval.`);
    }

    const item = this.episodic.get(workspaceId, itemId);
    if (!item) {
      throw new Error(`promoteToDurable: item ${itemId} not found in episodic store for workspace ${workspaceId}.`);
    }

    if (!this.feedback.meetsPromotionCriteria(itemId)) {
      throw new Error(
        `promoteToDurable: item ${itemId} does not meet promotion criteria ` +
        `(requires ≥2 positive-feedback sessions and confidence ≥0.8).`
      );
    }

    // Upgrade tier and persist to durable store
    const durableItem: MemoryItem = { ...item, tier: 'durable' };
    this.durable.store(durableItem);

    // Remove from episodic and clean up feedback
    this.episodic.remove(workspaceId, itemId);
    this.feedback.purge(itemId);

    return durableItem;
  }

  // ── Cross-tier retrieval ───────────────────────────────────────────────────

  /**
   * Find items across all tiers by tag.
   * Search order: durable → episodic → short-term.
   */
  findByTag(workspaceId: string, tag: string): MemoryItem[] {
    const durable = this.durable.findByTag(tag);
    const episodic = this.episodic.findByTag(workspaceId, tag);
    const shortTerm = Array.from(this.shortTerm.values()).filter(i => i.tags.includes(tag));
    return [...durable, ...episodic, ...shortTerm];
  }
}
