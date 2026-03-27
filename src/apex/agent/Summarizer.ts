// Co-authored by FORGE (Session: forge-20260327063704-3049883)
// src/apex/agent/Summarizer.ts — JAL-015 Task History Summarizer
//
// Summarizes goal loop task histories that exceed SUMMARY_TOKEN_THRESHOLD (2000 tokens)
// before they are included in the next LLM call. The raw history is retained in episodic
// memory by the caller — this module only produces the summary string.
//
// Safety gates:
//   - sanitize() removes lines containing credential-like patterns before any
//     content is sent to the LLM.
//   - LLM prompt explicitly instructs the model not to repeat credentials.
//   - Falls back to a deterministic summary if ProviderGateway is unavailable.

import { ProviderGateway } from '../auth/ProviderGateway';
import { approxTokens } from '../memory/ContextBudget';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Task histories exceeding this token count are summarized before LLM inclusion. */
export const SUMMARY_TOKEN_THRESHOLD = 2_000;

/**
 * Patterns identifying lines that likely contain credentials or secrets.
 * Any line matching at least one pattern is stripped before sending to the LLM.
 */
const SECRET_LINE_PATTERNS: RegExp[] = [
  // Explicit key/password assignments: key=value, token: value, etc.
  /\b(password|passwd|secret|token|api[_-]?key|auth[_-]?token|bearer|credential|private[_-]?key)\s*[=:]/i,
  // Long base64-like strings (>= 40 chars) typically indicating encoded secrets
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/,
  // OpenAI-style secret keys
  /\bsk-[A-Za-z0-9]{20,}/,
  // GitHub personal access tokens
  /\bghp_[A-Za-z0-9]{20,}/,
  // AWS access key IDs
  /\bAKIA[A-Z0-9]{16}/,
];

// ── Summarizer ────────────────────────────────────────────────────────────────

export class Summarizer {
  constructor(private readonly gateway: ProviderGateway) {}

  /**
   * Returns true if text exceeds SUMMARY_TOKEN_THRESHOLD tokens.
   * Deterministic — not LLM-driven.
   */
  shouldSummarize(text: string): boolean {
    return approxTokens(text) > SUMMARY_TOKEN_THRESHOLD;
  }

  /**
   * Remove lines containing credential-like patterns from text.
   * Safety gate: called before any content is passed to the LLM.
   */
  sanitize(text: string): string {
    return text
      .split('\n')
      .filter(line => !SECRET_LINE_PATTERNS.some(re => re.test(line)))
      .join('\n');
  }

  /**
   * Summarize a task execution history using ProviderGateway.
   *
   * - Sanitizes input before sending to LLM (safety gate).
   * - Raw history is NOT included in the return value; callers retain it separately.
   * - Falls back to a deterministic summary on gateway failure.
   *
   * @param goal    The goal currently being pursued.
   * @param history Raw task history text (accumulated prior step outputs).
   */
  async summarize(goal: string, history: string): Promise<string> {
    const sanitized = this.sanitize(history);

    const prompt =
      `You are summarizing an AI agent's task execution history.\n\n` +
      `Goal: ${goal.slice(0, 500)}\n\n` +
      `Produce a concise 3-5 bullet summary covering: what steps were completed, ` +
      `what succeeded, what failed, and what remains. ` +
      `Do NOT include credentials, tokens, raw file contents, or verbatim command output.\n\n` +
      `History:\n${sanitized.slice(0, 6_000)}\n\nSummary:`;

    try {
      const result = await this.gateway.complete([
        { role: 'user', content: prompt },
      ]);
      return result.content.trim();
    } catch {
      // Deterministic fallback — no LLM available
      const lines = history.split('\n').filter(l => l.trim().length > 0).length;
      const tokens = approxTokens(history);
      return (
        `[Task history — ${lines} non-empty lines, ~${tokens} tokens] ` +
        `Goal: "${goal.slice(0, 150)}"`
      );
    }
  }
}
