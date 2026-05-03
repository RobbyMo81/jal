// Co-authored by Apex Wakening Build
// src/apex/guardian_angle/EntropyMonitor.ts — Token entropy assessment
//
// Primary: compute entropy from Ollama logprobs (per-token log-probabilities).
// Fallback: text-based heuristic using uncertainty markers when logprobs absent.
//
// Entropy is normalized to [0, 1]. Values above the configured threshold
// trigger Guardian verification in the DVU protocol.

import type { OllamaTokenLogprob } from '../auth/OllamaAdapter';
import type { Domain, EntropyAssessment } from './types';
import type { GatewayMessage } from '../types';

// ── Constants ─────────────────────────────────────────────────────────────────

const UNCERTAINTY_MARKERS = [
  'perhaps', 'maybe', 'might', 'could be', 'possibly', 'probably',
  "i think", "i believe", "i'm not sure", "not certain", "it seems",
  "it appears", "it looks like", "approximately", "roughly", "unclear",
  "uncertain", "unsure", "i suppose", "i guess", "hypothetically",
];

const DOMAIN_PATTERNS: Array<{ pattern: RegExp; domain: Domain }> = [
  { pattern: /\b(docker|container|image|dockerfile|compose)\b/i, domain: 'system_admin' },
  { pattern: /\b(systemctl|journalctl|service|daemon|cron)\b/i, domain: 'system_admin' },
  { pattern: /\b(bash|grep|awk|sed|find|curl|wget|chmod|chown|xargs|pipe)\b/i, domain: 'shell_commands' },
  { pattern: /```[\w]*\n|function\s+\w+\s*\(|class\s+\w+|def\s+\w+\s*\(|import\s+\w+/m, domain: 'code_generation' },
  { pattern: /\b(calculate|compute|solve|proof|theorem|equation|derive|integral|matrix)\b/i, domain: 'reasoning' },
  { pattern: /\b(read|write|mkdir|rmdir|stat|chown|path|directory|symlink)\b/i, domain: 'file_operations' },
];

// ── EntropyMonitor ────────────────────────────────────────────────────────────

export class EntropyMonitor {
  private readonly threshold: number;

  constructor(threshold = 0.4) {
    this.threshold = threshold;
  }

  /**
   * Assess the entropy of a completion result.
   * Uses logprobs when available; falls back to text heuristics.
   */
  assess(
    text: string,
    domain: Domain,
    logprobs?: OllamaTokenLogprob[]
  ): EntropyAssessment {
    if (logprobs && logprobs.length > 0) {
      return this.assessFromLogprobs(text, domain, logprobs);
    }
    return this.assessFromText(text, domain);
  }

  /**
   * Detect the most likely domain from a message thread.
   * Scans the full message content for domain-specific patterns.
   */
  detectDomain(messages: GatewayMessage[]): Domain {
    const combined = messages.map(m => m.content).join('\n');
    for (const { pattern, domain } of DOMAIN_PATTERNS) {
      if (pattern.test(combined)) return domain;
    }
    return 'general';
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private assessFromLogprobs(
    text: string,
    domain: Domain,
    logprobs: OllamaTokenLogprob[]
  ): EntropyAssessment {
    // Each logprob is log(P(token)). Convert to confidence: P(token) = exp(logprob).
    // Average confidence across all output tokens.
    const confidences = logprobs.map(lp => Math.exp(lp.logprob));
    const avgConfidence = confidences.reduce((a, b) => a + b, 0) / confidences.length;

    // Entropy proxy: tokens with low confidence increase entropy.
    // Normalized Shannon entropy from confidence distribution:
    //   H = -Σ (c_i / total) * log2(c_i / total)
    // For our purposes: entropy = 1 - avgConfidence gives a clean [0,1] signal.
    const entropy = Math.max(0, Math.min(1, 1 - avgConfidence));

    return {
      entropy,
      confidence: avgConfidence,
      is_high_entropy: entropy >= this.threshold,
      source: 'logprobs',
      domain,
    };
  }

  private assessFromText(text: string, domain: Domain): EntropyAssessment {
    const lower = text.toLowerCase();
    const words = lower.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      return { entropy: 0, confidence: 1, is_high_entropy: false, source: 'text_heuristic', domain };
    }

    // Count uncertainty marker hits (allow multi-word markers)
    let hits = 0;
    for (const marker of UNCERTAINTY_MARKERS) {
      if (lower.includes(marker)) hits++;
    }

    // Also count explicit question marks mid-response (not trailing)
    const midQuestions = (text.match(/\?[^$]/g) ?? []).length;
    hits += midQuestions;

    // Normalize: scale hits against word count with a cap
    const rawScore = Math.min(1, (hits * 3) / Math.max(words.length, 10));
    const entropy = rawScore;
    const confidence = 1 - entropy;

    return {
      entropy,
      confidence,
      is_high_entropy: entropy >= this.threshold,
      source: 'text_heuristic',
      domain,
    };
  }
}
