// Co-authored by FORGE (Session: forge-20260327063704-3049883)
// src/apex/memory/ContextPacker.ts — JAL-015 Context Budget Packing
//
// Wraps ContextBudget to assemble and enforce prompt segments against the model's
// context budget allocation. All sizing and truncation decisions are logged at
// debug level so context optimization is fully auditable.
//
// Budget segments (from JAL-008 ContextBudget):
//   system_policy 25% | active_task_state 35% | recent_actions 25% | retrieved_memory 15%
//
// Truncation order when segments overflow:
//   retrieved_memory → recent_actions → active_task_state → system_policy (never truncated)

import { ContextBudget, approxTokens } from './ContextBudget';
import {
  ContextBudgetAllocation,
  ContextSegment,
  ModelProfileOverrides,
} from '../types';

// ── PackedContext ─────────────────────────────────────────────────────────────

export interface PackedContext {
  /** Content segments after budget enforcement. */
  segments: Record<ContextSegment, string[]>;
  /** Budget allocation computed for this operation. */
  budget: ContextBudgetAllocation;
  /**
   * Number of items removed per segment during enforcement.
   * Only segments where truncation occurred appear here.
   */
  truncated: Partial<Record<ContextSegment, number>>;
  /** Approximate total tokens across all packed segments. */
  total_tokens: number;
}

// ── ContextPackerParams ───────────────────────────────────────────────────────

export interface ContextPackerParams {
  /** Model context window in tokens. */
  contextWindow: number;
  /** system_policy segment content (identity + policy docs). */
  systemPolicy: string[];
  /** active_task_state segment content (goal + current step info). */
  activeTask: string[];
  /** recent_actions segment content (narrative, step outputs). */
  recentActions: string[];
  /** retrieved_memory segment content (top-K episodic memory snippets). */
  retrievedMemory: string[];
  /** Optional per-segment percentage overrides (see ModelProfiles). */
  overrides?: ModelProfileOverrides;
  /** Debug logger. Omit to suppress debug output. */
  logger?: (msg: string) => void;
}

// ── ContextPacker ─────────────────────────────────────────────────────────────

export class ContextPacker {
  constructor(private readonly contextBudget: ContextBudget) {}

  /**
   * Pack prompt content into budget-constrained segments.
   *
   * Steps:
   *   1. Compute budget allocation for the given context window.
   *   2. Log input segment sizes.
   *   3. Enforce per-segment token limits (ContextBudget.enforceLimit).
   *   4. Log truncation actions and output sizes.
   *   5. Return packed segments + budget metadata.
   */
  pack(params: ContextPackerParams): PackedContext {
    const {
      contextWindow,
      systemPolicy,
      activeTask,
      recentActions,
      retrievedMemory,
      overrides,
    } = params;
    const log = params.logger ?? ((_msg: string) => { /* no-op */ });

    // ── 1. Compute budget ────────────────────────────────────────────────────
    const budget = this.contextBudget.computeBudget(contextWindow, overrides);
    log(
      `[ContextPacker] window=${contextWindow} model=${budget.model_size} ` +
      `usable=${budget.usable_tokens}tok ` +
      `alloc=sp:${budget.system_policy.tokens}/` +
      `at:${budget.active_task_state.tokens}/` +
      `ra:${budget.recent_actions.tokens}/` +
      `rm:${budget.retrieved_memory.tokens}`
    );

    const inputSegments: Record<ContextSegment, string[]> = {
      system_policy:     systemPolicy,
      active_task_state: activeTask,
      recent_actions:    recentActions,
      retrieved_memory:  retrievedMemory,
    };

    // ── 2. Log input sizes ───────────────────────────────────────────────────
    for (const seg of ['system_policy', 'active_task_state', 'recent_actions', 'retrieved_memory'] as ContextSegment[]) {
      const tokens = inputSegments[seg].reduce((s, t) => s + approxTokens(t), 0);
      log(`[ContextPacker] input  ${seg}: ${inputSegments[seg].length} item(s) ~${tokens}tok`);
    }

    // ── 3. Enforce limits ────────────────────────────────────────────────────
    const output = this.contextBudget.enforceLimit(budget, inputSegments);

    // ── 4. Log truncation and output sizes ───────────────────────────────────
    const truncated: Partial<Record<ContextSegment, number>> = {};
    for (const seg of ['system_policy', 'active_task_state', 'recent_actions', 'retrieved_memory'] as ContextSegment[]) {
      const removed = inputSegments[seg].length - output[seg].length;
      if (removed > 0) {
        truncated[seg] = removed;
        log(
          `[ContextPacker] TRUNCATED ${removed} item(s) from ${seg} ` +
          `(limit=${budget[seg].tokens}tok)`
        );
      }
      const outTokens = output[seg].reduce((s, t) => s + approxTokens(t), 0);
      log(`[ContextPacker] output ${seg}: ${output[seg].length} item(s) ~${outTokens}tok`);
    }

    // ── 5. Compute total output tokens ───────────────────────────────────────
    const total_tokens = (
      ['system_policy', 'active_task_state', 'recent_actions', 'retrieved_memory'] as ContextSegment[]
    ).reduce((sum, seg) => sum + output[seg].reduce((s, t) => s + approxTokens(t), 0), 0);

    log(`[ContextPacker] total output ~${total_tokens}tok`);

    return { segments: output, budget, truncated, total_tokens };
  }
}
