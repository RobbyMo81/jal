// Co-authored by Apex Wakening Build
// src/apex/guardian_angle/types.ts — Guardian Angle module type definitions
//
// M_S = Student model (fast, local — e.g. qwen2.5-coder:7b)
// M_G = Guardian model (reasoning — e.g. deepseek-r1)

// ── Domain Classification ─────────────────────────────────────────────────────

export type Domain =
  | 'shell_commands'
  | 'code_generation'
  | 'reasoning'
  | 'file_operations'
  | 'system_admin'
  | 'general';

// ── Entropy Assessment ────────────────────────────────────────────────────────

export interface EntropyAssessment {
  /** Shannon entropy of the generation, normalized to [0, 1]. */
  entropy: number;
  /** Average token confidence: mean(exp(logprob_i)). Range [0, 1]. */
  confidence: number;
  /** True when entropy >= configured threshold. */
  is_high_entropy: boolean;
  /** Source of entropy estimate. */
  source: 'logprobs' | 'text_heuristic';
  domain: Domain;
}

// ── Point of Failure ──────────────────────────────────────────────────────────

export interface PointOfFailure {
  /**
   * 0-based word index where the first error begins.
   * null means Guardian found no errors (response approved) OR a parse error occurred.
   * Distinguish approval from parse error using the parseError flag.
   */
  index: number | null;
  /** One-sentence reason for the failure, or "correct" if approved. */
  reason: string;
  domain: Domain;
  /**
   * True when the Guardian's response could not be parsed as valid JSON.
   * A parse error is INCONCLUSIVE — not approval. Do not record as correct.
   */
  parseError?: boolean;
}

// ── Domain Sleep Tracker ──────────────────────────────────────────────────────

export interface DomainStats {
  domain: Domain;
  /** Total interactions recorded in the sliding window. */
  window_size: number;
  /** Count of approved (correct) interactions in the window. */
  correct_count: number;
  /** Accuracy = correct_count / window_size. Range [0, 1]. */
  accuracy: number;
  /** True when accuracy >= sleep_mode_threshold for a full window. */
  in_sleep_mode: boolean;
  sleep_started_at?: string;
  last_updated: string;
}

export interface DomainSleepState {
  version: number;
  updated_at: string;
  domains: Record<Domain, DomainStats>;
}

// ── Intervention Logging ──────────────────────────────────────────────────────

export interface InterventionRecord {
  id: string;
  timestamp: string;
  domain: Domain;
  student_model: string;
  guardian_model: string;
  /** Original student draft (first generation). */
  student_draft: string;
  /** Guardian's structured feedback text. */
  guardian_feedback: string;
  /** 0-based word index of the first error, or null if none. */
  pof_index: number | null;
  /** Final corrected output after DVU cycle(s). */
  corrected_output: string;
  /** Normalized entropy score of the original draft. */
  entropy_score: number;
  /** Number of DVU re-generation cycles performed (0 = guardian approved draft). */
  correction_cycles: number;
}

// ── Guardian Angle Config ─────────────────────────────────────────────────────

import type { IAdapterWithLogprobs } from '../../src/apex/auth/OllamaAdapter';
import type { GuardianBrain } from '../../src/apex/brain/GuardianBrain';

export interface GuardianAngleConfig {
  /** M_S: student model name (used with studentAdapter or a new OllamaAdapter). */
  studentModel: string;
  /** M_G: guardian model name (used with guardianAdapter or a new OllamaAdapter). */
  guardianModel: string;
  /**
   * Pre-built student adapter (FallbackProviderChain or OllamaAdapter).
   * If provided, studentBaseUrl is ignored.
   */
  studentAdapter?: IAdapterWithLogprobs;
  /**
   * Pre-built guardian adapter (FallbackProviderChain or OllamaAdapter).
   * If provided, guardianBaseUrl is ignored.
   */
  guardianAdapter?: IAdapterWithLogprobs;
  /** Ollama base URL for student (used only when studentAdapter is not provided). */
  studentBaseUrl?: string;
  /** Ollama base URL for guardian (used only when guardianAdapter is not provided). */
  guardianBaseUrl?: string;
  /** Guardian's persistent brain. When provided, verification history is logged. */
  brain?: GuardianBrain;
  /**
   * Entropy threshold that triggers Guardian verification.
   * Default: 0.4. Below this, the student draft is accepted without Guardian review.
   */
  entropyThreshold?: number;
  /**
   * Domain accuracy threshold τ for Sleep Mode.
   * When a domain's accuracy exceeds this over the window, Guardian skips it.
   * Default: 0.92.
   */
  sleepModeThreshold?: number;
  /**
   * Sliding window size for domain accuracy tracking.
   * Default: 20 interactions.
   */
  sleepModeWindow?: number;
  /**
   * Maximum DVU re-generation cycles per request.
   * Default: 2.
   */
  maxDVUCycles?: number;
  /**
   * Domains that always invoke Guardian regardless of entropy score.
   * Prevents high-confidence-but-wrong answers from bypassing verification.
   * Default: ['shell_commands', 'code_generation'].
   * Pass [] to disable forced verification entirely.
   */
  forcedVerifyDomains?: Domain[];
  /**
   * Directory for intervention log and sleep state files.
   * Defaults to ~/.apex/state/guardian/.
   */
  stateDir?: string;
}

// ── DVU Result ────────────────────────────────────────────────────────────────

import type { CompletionResult } from '../../src/apex/types';

export interface GuardianDVUResult extends CompletionResult {
  /** How many DVU correction cycles were performed (0 = draft accepted). */
  dvu_cycles: number;
  /** Whether the Guardian was invoked at all (false in sleep mode or low entropy). */
  guardian_invoked: boolean;
  /** PoF returned by the Guardian, if it was invoked. */
  pof?: PointOfFailure;
  /** Normalized entropy score of the initial student draft. */
  entropy_score: number;
  domain: Domain;
  /** True if the Guardian was in sleep mode for this domain. */
  sleep_mode_active: boolean;
}
