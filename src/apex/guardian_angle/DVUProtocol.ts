// Co-authored by Apex Wakening Build
// src/apex/guardian_angle/DVUProtocol.ts — Draft-Verify-Update protocol
//
// Implements the three-phase supervision cycle:
//   1. Draft  — M_S initial draft is passed in (already entropy-assessed).
//   2. Verify — M_G performs a single-pass logical audit → PoF or null.
//   3. Update — M_S re-generates from the PoF using Guardian feedback.
//
// execute() accepts the initial draft so GuardianAngle's entropy assessment
// result is reused rather than re-generating a fresh draft.
//
// Loop runs up to maxCycles iterations of (Verify → Update).
// Each iteration: if Guardian approves → break. If error → correct and continue.

import type { IAdapterWithLogprobs, OllamaExtendedResult } from '../auth/OllamaAdapter';
import type { GatewayMessage, CompletionOptions } from '../types';
import type { Domain, PointOfFailure, GuardianDVUResult } from './types';
import type { EntropyAssessment } from './types';

// ── Guardian verification prompt ──────────────────────────────────────────────

function buildVerifyMessages(
  originalMessages: GatewayMessage[],
  draft: string
): GatewayMessage[] {
  const lastUserMessage = [...originalMessages].reverse().find(m => m.role === 'user')?.content ?? '';

  return [
    {
      role: 'system',
      content:
        'You are a logical auditor. Examine the Student Response and find the FIRST error ' +
        '(logical mistake, factual error, unsafe command, or hallucination). ' +
        'Output ONLY a single line of valid JSON — no explanation outside it.\n' +
        'Format: {"pof":INDEX_OR_NULL,"reason":"ONE_SENTENCE","domain":"DOMAIN"}\n' +
        'INDEX is the 0-based word position of the first error (null if correct).\n' +
        'DOMAIN is one of: shell_commands, code_generation, reasoning, file_operations, system_admin, general.',
    },
    {
      role: 'user',
      content: `Original request: ${lastUserMessage}\n\nStudent Response: ${draft}\n\nJSON:`,
    },
  ];
}

// ── PoF response parsing ──────────────────────────────────────────────────────

function parsePoF(raw: string, fallbackDomain: Domain): PointOfFailure {
  const trimmed = raw.trim();
  const match = trimmed.match(/\{[^}]+\}/);
  if (!match) {
    return { index: null, reason: 'guardian parse error — treating as approved', domain: fallbackDomain };
  }
  try {
    const parsed = JSON.parse(match[0]) as { pof?: unknown; reason?: unknown; domain?: unknown };
    const index = typeof parsed.pof === 'number' ? Math.max(0, Math.floor(parsed.pof)) : null;
    const reason = typeof parsed.reason === 'string' ? parsed.reason : 'no reason provided';
    const domain = (typeof parsed.domain === 'string' ? parsed.domain : fallbackDomain) as Domain;
    return { index, reason, domain };
  } catch {
    return { index: null, reason: 'guardian parse error — treating as approved', domain: fallbackDomain };
  }
}

// ── Correction message construction ──────────────────────────────────────────

function buildCorrectionMessages(
  originalMessages: GatewayMessage[],
  draft: string,
  pof: PointOfFailure
): GatewayMessage[] {
  const words = draft.split(/\s+/);
  const prefix = pof.index !== null && pof.index > 0
    ? words.slice(0, pof.index).join(' ')
    : '';

  const correctionHint = prefix
    ? `Your response was correct up to: "${prefix.slice(-100)}"\n\nError at word ${pof.index}: ${pof.reason}\n\nProvide the complete corrected response.`
    : `Your response contained an error: ${pof.reason}\n\nProvide the complete corrected response.`;

  return [
    ...originalMessages,
    { role: 'assistant' as const, content: draft },
    { role: 'user' as const, content: correctionHint },
  ];
}

// ── DVUProtocol ───────────────────────────────────────────────────────────────

export interface DVUExecuteOptions extends CompletionOptions {
  maxCycles?: number;
}

export class DVUProtocol {
  private readonly guardian: IAdapterWithLogprobs;
  private readonly guardianModel: string;

  constructor(guardianAdapter: IAdapterWithLogprobs, guardianModel: string) {
    this.guardian = guardianAdapter;
    this.guardianModel = guardianModel;
  }

  /**
   * Run DVU starting from an already-generated initial draft.
   * Loops up to maxCycles: (Verify → correct if error). Returns after Guardian
   * approves or the cycle limit is reached.
   */
  async execute(
    messages: GatewayMessage[],
    student: IAdapterWithLogprobs,
    studentModel: string,
    entropy: EntropyAssessment,
    initialDraft: OllamaExtendedResult,
    opts: DVUExecuteOptions = {}
  ): Promise<GuardianDVUResult> {
    const maxCycles = opts.maxCycles ?? 2;
    let draft: OllamaExtendedResult = initialDraft;
    let dvuCycles = 0;
    let lastPof: PointOfFailure | undefined;

    for (let i = 0; i < maxCycles; i++) {
      const pof = await this.verify(messages, draft.content, entropy.domain);
      lastPof = pof;

      if (pof.index === null) break; // Guardian approved

      dvuCycles++;
      // Re-generate from PoF
      const correctionMessages = buildCorrectionMessages(messages, draft.content, pof);
      draft = await student.completeWithLogprobs(correctionMessages, studentModel, opts);
    }

    return {
      content: draft.content,
      model: draft.model,
      provider: 'guardian',
      usage: draft.usage,
      dvu_cycles: dvuCycles,
      guardian_invoked: true,
      pof: lastPof,
      entropy_score: entropy.entropy,
      domain: entropy.domain,
      sleep_mode_active: false,
    };
  }

  /**
   * Verify a draft with the Guardian model.
   * Returns a PointOfFailure — index is null if the draft is approved.
   */
  async verify(
    originalMessages: GatewayMessage[],
    draft: string,
    domain: Domain
  ): Promise<PointOfFailure> {
    const verifyMessages = buildVerifyMessages(originalMessages, draft);
    const result = await this.guardian.completeWithLogprobs(
      verifyMessages,
      this.guardianModel,
      { temperature: 0.1, max_tokens: 128 }
    );
    return parsePoF(result.content, domain);
  }
}
