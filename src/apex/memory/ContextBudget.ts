// Co-authored by FORGE (Session: forge-20260325062232-1899997)
// src/apex/memory/ContextBudget.ts — JAL-008 Context Budget Allocation & Enforcement
//
// Deterministic context budget rules per PRD JAL-008:
//
//   Default split:  system_policy 25% | active_task_state 35% | recent_actions 25% | retrieved_memory 15%
//   Large  (≥100K): full context window, default split
//   Medium (16K–100K): ×0.75 scaling on total usable tokens
//   Small  (<16K):  ×0.50 scaling; minimum floors: system_policy ≥10%, active_task_state ≥15%
//
//   Truncation order (on breach):
//     1. retrieved_memory  (oldest first)
//     2. recent_actions    (oldest first)
//     3. active_task_state (lowest relevance = last items first)
//     4. system_policy     (NEVER truncated)
//
//   Tool output chunking:
//     If output exceeds CHUNK_TOKEN_THRESHOLD (1000 tokens), retain first 500 + last 500 tokens
//     in the prompt; store full content via OutputStore (SHA256-referenced).
//
// TOKEN APPROXIMATION: 1 token ≈ 4 UTF-8 bytes (standard heuristic).

import { OutputStore } from '../checkpoint/OutputStore';
import { ModelProfiles } from './ModelProfiles';
import {
  BudgetSegmentAllocation,
  ContextBudgetAllocation,
  ContextSegment,
  ModelProfileOverrides,
  ModelSize,
  ToolOutputChunk,
  ToolOutputRef,
} from '../types';

// ── Constants ─────────────────────────────────────────────────────────────────

/** UTF-8 bytes per token (approximation). */
const BYTES_PER_TOKEN = 4;

/** Default segment percentages. */
const DEFAULT_PCT: Record<ContextSegment, number> = {
  system_policy:     25,
  active_task_state: 35,
  recent_actions:    25,
  retrieved_memory:  15,
};

/** Minimum floors (applied only for small models after scaling). */
const SMALL_MODEL_FLOORS: Partial<Record<ContextSegment, number>> = {
  system_policy:     10,
  active_task_state: 15,
};

/** Scale factors per model size. */
const SCALE: Record<ModelSize, number> = {
  large:  1.0,
  medium: 0.75,
  small:  0.50,
};

/**
 * Token threshold above which a tool output is chunked.
 * At 1000 tokens the prompt receives first 500 + last 500.
 */
export const CHUNK_TOKEN_THRESHOLD = 1_000;
export const CHUNK_HEAD_TOKENS = 500;
export const CHUNK_TAIL_TOKENS = 500;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Approximate token count for a string (UTF-8 bytes / 4). */
export function approxTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / BYTES_PER_TOKEN);
}

/** Convert token count to approximate UTF-8 byte count. */
function tokensToBytes(tokens: number): number {
  return tokens * BYTES_PER_TOKEN;
}

/**
 * Truncate a string to at most `maxTokens` tokens by keeping the first N bytes.
 * Returns the original string if it already fits.
 */
function truncateToTokens(text: string, maxTokens: number): string {
  const maxBytes = tokensToBytes(maxTokens);
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  return buf.slice(0, maxBytes).toString('utf8');
}

// ── ContextBudget ─────────────────────────────────────────────────────────────

export class ContextBudget {
  private readonly outputStore: OutputStore;

  constructor(stateDir?: string) {
    this.outputStore = new OutputStore(stateDir);
  }

  // ── Budget computation ─────────────────────────────────────────────────────

  /**
   * Compute the context budget allocation for a given context window.
   *
   * @param contextWindow  Model's total context window in tokens.
   * @param overrides      Optional per-segment percentage overrides (must sum ≤ 100).
   */
  computeBudget(contextWindow: number, overrides?: ModelProfileOverrides): ContextBudgetAllocation {
    const modelSize = ModelProfiles.getModelSize(contextWindow);
    const scale = SCALE[modelSize];
    const usableTokens = Math.floor(contextWindow * scale);

    // Build effective percentages (overrides replace defaults per key)
    const pct: Record<ContextSegment, number> = {
      system_policy:     overrides?.system_policy_pct     ?? DEFAULT_PCT.system_policy,
      active_task_state: overrides?.active_task_state_pct ?? DEFAULT_PCT.active_task_state,
      recent_actions:    overrides?.recent_actions_pct    ?? DEFAULT_PCT.recent_actions,
      retrieved_memory:  overrides?.retrieved_memory_pct  ?? DEFAULT_PCT.retrieved_memory,
    };

    // Apply minimum floors for small models
    if (modelSize === 'small') {
      for (const [seg, floor] of Object.entries(SMALL_MODEL_FLOORS) as [ContextSegment, number][]) {
        if (pct[seg] < floor) {
          pct[seg] = floor;
        }
      }
    }

    const makeAlloc = (segment: ContextSegment): BudgetSegmentAllocation => ({
      percent: pct[segment],
      tokens:  Math.floor(usableTokens * pct[segment] / 100),
    });

    return {
      total_context_window: contextWindow,
      usable_tokens:        usableTokens,
      model_size:           modelSize,
      system_policy:        makeAlloc('system_policy'),
      active_task_state:    makeAlloc('active_task_state'),
      recent_actions:       makeAlloc('recent_actions'),
      retrieved_memory:     makeAlloc('retrieved_memory'),
    };
  }

  // ── Budget enforcement ─────────────────────────────────────────────────────

  /**
   * Given the current token usage per segment, determine how many tokens are
   * available in each segment.
   *
   * Returns a per-segment map of { allocated, used, available }.
   */
  segmentUsage(
    budget: ContextBudgetAllocation,
    usedTokens: Record<ContextSegment, number>,
  ): Record<ContextSegment, { allocated: number; used: number; available: number }> {
    const segments: ContextSegment[] = ['system_policy', 'active_task_state', 'recent_actions', 'retrieved_memory'];
    const result = {} as Record<ContextSegment, { allocated: number; used: number; available: number }>;
    for (const seg of segments) {
      const allocated = budget[seg].tokens;
      const used = usedTokens[seg] ?? 0;
      result[seg] = { allocated, used, available: Math.max(0, allocated - used) };
    }
    return result;
  }

  /**
   * Enforce the context budget on a set of text items per segment.
   * Items are arrays of strings; truncation removes items (not partial text)
   * in the order specified by the PRD.
   *
   * Truncation order:
   *   retrieved_memory  → oldest first (first elements in array)
   *   recent_actions    → oldest first (first elements in array)
   *   active_task_state → lowest relevance = last items in array first
   *   system_policy     → NEVER truncated (safety gate)
   *
   * @param budget    Pre-computed budget allocation.
   * @param segments  Content to fit; arrays ordered oldest-first within each segment.
   * @returns         Segments with items removed to fit within token limits.
   */
  enforceLimit(
    budget: ContextBudgetAllocation,
    segments: Record<ContextSegment, string[]>,
  ): Record<ContextSegment, string[]> {
    // Deep-copy so we don't mutate the caller's data
    const result: Record<ContextSegment, string[]> = {
      system_policy:     [...segments.system_policy],
      active_task_state: [...segments.active_task_state],
      recent_actions:    [...segments.recent_actions],
      retrieved_memory:  [...segments.retrieved_memory],
    };

    // Enforce per-segment limits first
    for (const seg of ['system_policy', 'active_task_state', 'recent_actions', 'retrieved_memory'] as ContextSegment[]) {
      const limit = budget[seg].tokens;
      result[seg] = this._fitToLimit(result[seg], limit, seg === 'active_task_state' ? 'tail' : 'head');
    }

    return result;
  }

  /**
   * Truncate an array of strings so the total token count fits within `limit`.
   *
   * @param mode  'head' = remove from front (oldest first); 'tail' = remove from end (lowest relevance).
   */
  private _fitToLimit(items: string[], limit: number, mode: 'head' | 'tail'): string[] {
    let total = items.reduce((s, t) => s + approxTokens(t), 0);
    if (total <= limit) return items;

    const copy = [...items];
    while (copy.length > 0 && total > limit) {
      const removed = mode === 'head' ? copy.shift()! : copy.pop()!;
      total -= approxTokens(removed);
    }
    return copy;
  }

  // ── Tool output chunking ───────────────────────────────────────────────────

  /**
   * Chunk a large tool output for prompt use.
   *
   * If the output is ≤ CHUNK_TOKEN_THRESHOLD tokens, it is returned as-is
   * (was_chunked = false, full_ref = inline ref).
   *
   * Otherwise, a chunked version retaining the first 500 and last 500 tokens
   * is produced for the prompt; the full output is stored on disk via OutputStore
   * and referenced by SHA256 hash.
   */
  chunkToolOutput(content: string): ToolOutputChunk {
    const fullRef: ToolOutputRef = this.outputStore.store(content);
    const totalTokens = approxTokens(content);

    if (totalTokens <= CHUNK_TOKEN_THRESHOLD) {
      return {
        prompt_content: content,
        full_ref: fullRef,
        was_chunked: false,
      };
    }

    // Build prompt_content: first 500 tokens + separator + last 500 tokens
    const headBytes = tokensToBytes(CHUNK_HEAD_TOKENS);
    const tailBytes = tokensToBytes(CHUNK_TAIL_TOKENS);
    const buf = Buffer.from(content, 'utf8');

    const head = buf.slice(0, headBytes).toString('utf8');
    const tail = buf.slice(Math.max(headBytes, buf.length - tailBytes)).toString('utf8');

    const omittedTokens = totalTokens - CHUNK_HEAD_TOKENS - CHUNK_TAIL_TOKENS;
    const separator = `\n... [${omittedTokens} tokens omitted — full output stored at SHA256:${fullRef.hash}] ...\n`;

    return {
      prompt_content: head + separator + tail,
      full_ref: fullRef,
      was_chunked: true,
    };
  }

  /**
   * Retrieve the full content of a previously chunked output.
   * Delegates to OutputStore.retrieve() which verifies SHA256 on read.
   */
  retrieveFullOutput(ref: ToolOutputRef): string {
    return this.outputStore.retrieve(ref);
  }
}
