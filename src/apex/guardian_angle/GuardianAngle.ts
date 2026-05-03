// src/apex/guardian_angle/GuardianAngle.ts — Guardian Angle provider adapter
//
// Implements IProviderAdapter. Internally orchestrates:
//   M_S (Student) — fast local model for initial generation
//   M_G (Guardian) — reasoning model/chain for single-pass verification
//
// Either OllamaAdapter instances or FallbackProviderChain objects may be
// injected via GuardianAngleConfig.studentAdapter / .guardianAdapter.
// When not injected, OllamaAdapters are constructed from studentBaseUrl.
//
// Pipeline per request:
//   1. Student drafts a response.
//   2. EntropyMonitor assesses confidence.
//   3. If low entropy or domain in Sleep Mode → return draft immediately.
//   4. Otherwise → DVUProtocol (Draft-Verify-Update).
//   5. Log Guardian interventions for offline LoRA distillation.
//   6. Log to GuardianBrain if wired.

import { randomUUID } from 'crypto';
import { join } from 'path';
import { homedir } from 'os';
import { OllamaAdapter } from '../auth/OllamaAdapter';
import type { IAdapterWithLogprobs, OllamaExtendedResult } from '../auth/OllamaAdapter';
import type { IProviderAdapter } from '../auth/ProviderGateway';
import type { GatewayMessage, CompletionOptions, CompletionResult } from '../types';
import { EntropyMonitor } from './EntropyMonitor';
import { DVUProtocol } from './DVUProtocol';
import { DomainSleepTracker } from './DomainSleepTracker';
import { InterventionLogger } from './InterventionLogger';
import type { GuardianAngleConfig, GuardianDVUResult, InterventionRecord } from './types';

// ── GuardianAngle ─────────────────────────────────────────────────────────────

export class GuardianAngle implements IProviderAdapter {
  readonly provider = 'guardian';

  private readonly student: IAdapterWithLogprobs;
  private readonly guardian: IAdapterWithLogprobs;
  private readonly studentModel: string;
  private readonly guardianModel: string;
  private readonly entropyMonitor: EntropyMonitor;
  private readonly dvuProtocol: DVUProtocol;
  private readonly sleepTracker: DomainSleepTracker;
  private readonly interventionLogger: InterventionLogger;
  private readonly maxDVUCycles: number;
  private readonly brain: GuardianAngleConfig['brain'];

  constructor(config: GuardianAngleConfig) {
    const stateDir = config.stateDir ?? join(homedir(), '.apex', 'state', 'guardian');

    this.studentModel = config.studentModel;
    this.guardianModel = config.guardianModel;
    this.brain = config.brain;

    this.student = config.studentAdapter
      ?? new OllamaAdapter({ baseUrl: config.studentBaseUrl });

    this.guardian = config.guardianAdapter
      ?? new OllamaAdapter({ baseUrl: config.guardianBaseUrl ?? config.studentBaseUrl });

    this.entropyMonitor = new EntropyMonitor(config.entropyThreshold ?? 0.4);
    this.dvuProtocol = new DVUProtocol(this.guardian, this.guardianModel);
    this.sleepTracker = new DomainSleepTracker(stateDir, config.sleepModeThreshold, config.sleepModeWindow);
    this.interventionLogger = new InterventionLogger(stateDir);
    this.maxDVUCycles = config.maxDVUCycles ?? 2;
  }

  /**
   * Non-streaming completion through the Guardian Angle pipeline.
   * Token param unused — all inference is local or credential-managed by the chain.
   */
  async complete(
    messages: GatewayMessage[],
    _model: string,
    _token: string,
    opts: CompletionOptions
  ): Promise<CompletionResult> {
    return this.runPipeline(messages, opts);
  }

  /**
   * Streaming completion. Student streams directly to caller.
   * After streaming, DVU verification runs on the collected draft.
   * If DVU produces a correction, the corrected content is the return value.
   */
  async stream(
    messages: GatewayMessage[],
    _model: string,
    _token: string,
    opts: CompletionOptions,
    onChunk: (chunk: string) => void
  ): Promise<CompletionResult> {
    const domain = this.entropyMonitor.detectDomain(messages);

    // If Guardian is sleeping for this domain, stream directly from student
    if (this.sleepTracker.isSleeping(domain)) {
      const result = await this.streamFromStudent(messages, opts, onChunk);
      this.brain?.setActiveDomain(domain);
      return { content: result.content, model: result.model, provider: 'guardian', usage: result.usage };
    }

    // Stream from student, collect full draft for verification
    const chunks: string[] = [];
    const result = await this.streamFromStudent(
      messages,
      opts,
      (chunk) => { onChunk(chunk); chunks.push(chunk); }
    );

    const draft = chunks.join('');
    const entropy = this.entropyMonitor.assess(draft, domain, result.logprobs);

    // Low entropy → accept draft, update sleep tracker
    if (!entropy.is_high_entropy) {
      this.sleepTracker.record(domain, true);
      this.brain?.logVerification(domain, this.studentModel, this.guardianModel, entropy.entropy, 0, false);
      return { content: draft, model: result.model, provider: 'guardian', usage: result.usage };
    }

    // High entropy → DVU verification (reuse streamed result as initial draft)
    const dvuResult = await this.dvuProtocol.execute(
      messages,
      this.student,
      this.studentModel,
      entropy,
      result,
      { ...opts, maxCycles: this.maxDVUCycles }
    );

    this.recordOutcome(dvuResult, result.content, result.model);
    return dvuResult;
  }

  // ── Private ──────────────────────────────────────────────────────────────────

  private async runPipeline(
    messages: GatewayMessage[],
    opts: CompletionOptions
  ): Promise<GuardianDVUResult> {
    const domain = this.entropyMonitor.detectDomain(messages);
    this.brain?.setActiveDomain(domain);

    // ── Sleep Mode: skip Guardian entirely ────────────────────────────────────
    if (this.sleepTracker.isSleeping(domain)) {
      const result = await this.student.completeWithLogprobs(messages, this.studentModel, opts);
      this.brain?.logVerification(domain, this.studentModel, this.guardianModel, 0, 0, false);
      return {
        content: result.content,
        model: result.model,
        provider: 'guardian',
        usage: result.usage,
        dvu_cycles: 0,
        guardian_invoked: false,
        entropy_score: 0,
        domain,
        sleep_mode_active: true,
      };
    }

    // ── Student draft ─────────────────────────────────────────────────────────
    const draft = await this.student.completeWithLogprobs(messages, this.studentModel, opts);
    const entropy = this.entropyMonitor.assess(draft.content, domain, draft.logprobs);

    // ── Low entropy: accept draft without Guardian review ─────────────────────
    if (!entropy.is_high_entropy) {
      this.sleepTracker.record(domain, true);
      this.brain?.logVerification(domain, this.studentModel, this.guardianModel, entropy.entropy, 0, false);
      return {
        content: draft.content,
        model: draft.model,
        provider: 'guardian',
        usage: draft.usage,
        dvu_cycles: 0,
        guardian_invoked: false,
        entropy_score: entropy.entropy,
        domain,
        sleep_mode_active: false,
      };
    }

    // ── High entropy: run DVU (reuse draft already fetched above) ────────────
    const dvuResult = await this.dvuProtocol.execute(
      messages,
      this.student,
      this.studentModel,
      entropy,
      draft,
      { ...opts, maxCycles: this.maxDVUCycles }
    );

    this.recordOutcome(dvuResult, draft.content, draft.model);
    return dvuResult;
  }

  private async streamFromStudent(
    messages: GatewayMessage[],
    opts: CompletionOptions,
    onChunk: (chunk: string) => void
  ): Promise<OllamaExtendedResult> {
    // Duck-type check: prefer streamWithLogprobs (OllamaAdapter) when available
    const studentAny = this.student as unknown as Record<string, unknown>;
    if (typeof studentAny['streamWithLogprobs'] === 'function') {
      const fn = studentAny['streamWithLogprobs'] as (
        messages: GatewayMessage[],
        model: string,
        opts: CompletionOptions,
        onChunk: (chunk: string) => void
      ) => Promise<OllamaExtendedResult>;
      return fn.call(this.student, messages, this.studentModel, opts, onChunk);
    }
    // Fallback: standard stream() — no logprobs; entropy uses text heuristic
    const adapterWithStream = this.student as unknown as IProviderAdapter;
    const result = await adapterWithStream.stream(messages, this.studentModel, '', opts, onChunk);
    return result as OllamaExtendedResult;
  }

  private recordOutcome(
    result: GuardianDVUResult,
    originalDraft: string,
    draftModel: string
  ): void {
    const wasCorrect = result.dvu_cycles === 0 || result.pof?.index === null;
    this.sleepTracker.record(result.domain, wasCorrect);

    this.brain?.logVerification(
      result.domain,
      draftModel,
      this.guardianModel,
      result.entropy_score,
      result.dvu_cycles,
      result.dvu_cycles > 0
    );

    // Only log to intervention file if Guardian actually corrected
    if (result.guardian_invoked && result.dvu_cycles > 0) {
      const record: InterventionRecord = {
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        domain: result.domain,
        student_model: draftModel,
        guardian_model: this.guardianModel,
        student_draft: originalDraft,
        guardian_feedback: result.pof?.reason ?? '',
        pof_index: result.pof?.index ?? null,
        corrected_output: result.content,
        entropy_score: result.entropy_score,
        correction_cycles: result.dvu_cycles,
      };
      this.interventionLogger.log(record);
    }
  }

  /** Expose sleep tracker for diagnostics / Canvas status panel. */
  getSleepStats(): ReturnType<DomainSleepTracker['allStats']> {
    return this.sleepTracker.allStats();
  }

  /** Expose intervention log for diagnostics. */
  getInterventionLogger(): InterventionLogger {
    return this.interventionLogger;
  }
}
