// src/apex/brain/types.ts — Shared brain type definitions

export interface WorkingMemory {
  /** Last updated timestamp (ISO 8601). */
  updated_at: string;
  /** Arbitrary key→value store for active context. */
  facts: Record<string, unknown>;
}

export interface BrainTraceEntry {
  id: string;
  timestamp: string;
  type: string;
  data: Record<string, unknown>;
}

// ── JALBrain schema ───────────────────────────────────────────────────────────

export interface JALWorkingMemory extends WorkingMemory {
  active_goal: string | null;
  last_provider: string | null;
  last_model: string | null;
  session_count: number;
}

export type ReasoningTraceEntry = BrainTraceEntry & {
  type: 'reasoning';
  data: {
    goal: string;
    steps: string[];
    outcome: string;
  };
};

export type ProviderEventEntry = BrainTraceEntry & {
  type: 'provider_event';
  data: {
    event: 'success' | 'failure' | 'fallback';
    provider: string;
    model: string;
    error?: string;
  };
};

// ── GuardianBrain schema ──────────────────────────────────────────────────────

export interface GuardianWorkingMemory extends WorkingMemory {
  active_domain: string | null;
  last_student_model: string | null;
  last_guardian_model: string | null;
  total_interventions: number;
}

export interface DomainKnowledge {
  updated_at: string;
  /** domain → known patterns or notes, built from intervention history */
  domains: Record<string, { notes: string[]; last_updated: string }>;
}

export type VerificationEntry = BrainTraceEntry & {
  type: 'verification';
  data: {
    domain: string;
    student_model: string;
    guardian_model: string;
    entropy_score: number;
    dvu_cycles: number;
    corrected: boolean;
  };
};

export type FallbackEventEntry = BrainTraceEntry & {
  type: 'fallback_event';
  data: {
    event: 'chain_exhausted' | 'link_failed' | 'link_recovered';
    chain: string;
    link_provider: string;
    link_model: string;
    error?: string;
  };
};
