// src/apex/brain/JALBrain.ts — JAL's persistent sphere of influence
//
// Sphere: ~/.apex/brains/jal/
//   working_memory.json   — active goal, last provider/model, session count
//   reasoning_trace.ndjson — per-goal reasoning steps and outcomes
//   provider_events.ndjson — provider success/failure/fallback events

import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import { BrainStore } from './BrainStore';
import type {
  JALWorkingMemory,
  ReasoningTraceEntry,
  ProviderEventEntry,
} from './types';

const DEFAULT_MEMORY: JALWorkingMemory = {
  updated_at: '',
  facts: {},
  active_goal: null,
  last_provider: null,
  last_model: null,
  session_count: 0,
};

export class JALBrain {
  private readonly store: BrainStore<JALWorkingMemory>;

  constructor(brainDir?: string) {
    const dir = brainDir ?? join(homedir(), '.apex', 'brains', 'jal');
    this.store = new BrainStore<JALWorkingMemory>(dir);
  }

  // ── Working memory ─────────────────────────────────────────────────────────

  getMemory(): JALWorkingMemory {
    return this.store.readMemory(DEFAULT_MEMORY);
  }

  setGoal(goal: string | null): void {
    const mem = this.getMemory();
    mem.active_goal = goal;
    this.store.writeMemory(mem);
  }

  recordProvider(provider: string, model: string): void {
    const mem = this.getMemory();
    mem.last_provider = provider;
    mem.last_model = model;
    this.store.writeMemory(mem);
  }

  incrementSession(): void {
    const mem = this.getMemory();
    mem.session_count += 1;
    this.store.writeMemory(mem);
  }

  setFact(key: string, value: unknown): void {
    const mem = this.getMemory();
    mem.facts[key] = value;
    this.store.writeMemory(mem);
  }

  // ── Reasoning trace ────────────────────────────────────────────────────────

  logReasoning(goal: string, steps: string[], outcome: string): void {
    const entry: ReasoningTraceEntry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      type: 'reasoning',
      data: { goal, steps, outcome },
    };
    this.store.appendLog('reasoning_trace', entry);
  }

  getReasoningTrace(limit = 50): ReasoningTraceEntry[] {
    return this.store.readLog('reasoning_trace', limit) as ReasoningTraceEntry[];
  }

  // ── Provider events ────────────────────────────────────────────────────────

  logProviderEvent(
    event: 'success' | 'failure' | 'fallback',
    provider: string,
    model: string,
    error?: string
  ): void {
    const entry: ProviderEventEntry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      type: 'provider_event',
      data: { event, provider, model, error },
    };
    this.store.appendLog('provider_events', entry);
  }

  getProviderEvents(limit = 50): ProviderEventEntry[] {
    return this.store.readLog('provider_events', limit) as ProviderEventEntry[];
  }
}
