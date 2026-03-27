// Co-authored by FORGE (Session: forge-20260327063704-3049883)
// src/apex/memory/RelevanceScorer.ts — JAL-015 Episodic Memory Relevance Scoring
//
// Scores MemoryItems against a goal statement using two signals:
//
//   keyword overlap (0.6 weight) — fraction of unique goal terms found in item content
//   recency         (0.4 weight) — 1 / (1 + ageInDays), decays from 1.0 toward 0
//
// Safety gate: items with sensitive === true are NEVER returned, regardless of score.
// Deterministic and unit-testable — not LLM-driven.

import { MemoryItem } from '../types';

// ── Constants ─────────────────────────────────────────────────────────────────

export const KEYWORD_WEIGHT = 0.6;
export const RECENCY_WEIGHT = 0.4;
export const DEFAULT_TOP_K = 10;

/** Common English stop words excluded from keyword matching. */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'has', 'have', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'that', 'this', 'it', 'as', 'not', 'i', 'we',
  'you', 'he', 'she', 'they', 'my', 'your', 'our', 'its', 'than', 'then',
  'so', 'if', 'no', 'up', 'out', 'me', 'him', 'her', 'us', 'them',
]);

// ── RelevanceScorer ───────────────────────────────────────────────────────────

export class RelevanceScorer {
  /**
   * Tokenize text into lowercase words, excluding stop words and tokens
   * shorter than 2 characters. Deterministic — splits on non-word characters.
   */
  static tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .split(/[\W_]+/)
      .filter(t => t.length >= 2 && !STOP_WORDS.has(t));
  }

  /**
   * Build a keyword frequency map from the goal statement.
   * Maps each unique term to its frequency count in the goal text.
   */
  buildKeywordIndex(goal: string): Map<string, number> {
    const tokens = RelevanceScorer.tokenize(goal);
    const freq = new Map<string, number>();
    for (const t of tokens) {
      freq.set(t, (freq.get(t) ?? 0) + 1);
    }
    return freq;
  }

  /**
   * Score a single MemoryItem against a pre-built keyword index.
   *
   * score = KEYWORD_WEIGHT * keywordOverlap + RECENCY_WEIGHT * recencyScore
   *
   * keywordOverlap: fraction of unique goal terms present in item content (0–1)
   * recencyScore:   1 / (1 + ageInDays), ranging from ~1.0 (just accessed) toward 0
   *
   * @param keywordIndex  Pre-computed from buildKeywordIndex(goal).
   * @param item          The memory item to score.
   * @param now           Reference timestamp for recency calculation (injectable for tests).
   */
  scoreItem(
    keywordIndex: Map<string, number>,
    item: MemoryItem,
    now: Date = new Date()
  ): number {
    // Keyword overlap score [0, 1]
    const uniqueGoalTerms = keywordIndex.size;
    let keywordScore = 0;
    if (uniqueGoalTerms > 0) {
      const contentTokens = new Set(RelevanceScorer.tokenize(item.content));
      let overlap = 0;
      for (const term of keywordIndex.keys()) {
        if (contentTokens.has(term)) overlap++;
      }
      keywordScore = Math.min(1, overlap / uniqueGoalTerms);
    }

    // Recency score [0, 1]
    const ageMs = Math.max(0, now.getTime() - new Date(item.last_accessed_at).getTime());
    const ageInDays = ageMs / (1000 * 60 * 60 * 24);
    const recencyScore = 1 / (1 + ageInDays);

    return KEYWORD_WEIGHT * keywordScore + RECENCY_WEIGHT * recencyScore;
  }

  /**
   * Select the top-K most relevant MemoryItems for the given goal.
   *
   * Safety gate: items with sensitive === true are ALWAYS excluded regardless of score.
   *
   * @param goal   The goal statement to score against.
   * @param items  Candidate items (caller supplies episodic + any durable items).
   * @param k      Maximum number of results (default DEFAULT_TOP_K = 10).
   * @param now    Reference time for recency (injectable for testing).
   */
  selectTopK(
    goal: string,
    items: MemoryItem[],
    k: number = DEFAULT_TOP_K,
    now: Date = new Date()
  ): MemoryItem[] {
    const index = this.buildKeywordIndex(goal);

    return items
      .filter(item => item.sensitive !== true)  // safety gate — never expose sensitive items
      .map(item => ({ item, score: this.scoreItem(index, item, now) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map(s => s.item);
  }
}
