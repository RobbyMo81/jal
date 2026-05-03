// src/apex/providers/FallbackProviderChain.ts — Ordered fallback provider chain
//
// Implements IProviderAdapter. Tries each link in order, skipping any whose
// CircuitBreaker is OPEN. Records success/failure on the breaker after each call.
//
// completeWithLogprobs() is exposed via duck typing: if the winning adapter
// has that method, it is called directly (used by GuardianAngle for entropy).
//
// Token per link: the chain holds a token for each link. The outer token param
// from IProviderAdapter.complete() is the fallback token used only if a link
// has no pre-configured token.

import { IProviderAdapter } from '../auth/ProviderGateway';
import { GatewayMessage, CompletionOptions, CompletionResult } from '../types';
import { CircuitBreaker, CircuitBreakerOptions } from './CircuitBreaker';
import type { OllamaExtendedResult } from '../auth/OllamaAdapter';

export interface ChainLink {
  adapter: IProviderAdapter;
  /** Model to use for this link. */
  model: string;
  /**
   * Pre-configured auth token for this link.
   * Local adapters (Ollama) can pass an empty string.
   */
  token: string;
  /** Circuit breaker options for this link. */
  breakerOpts?: CircuitBreakerOptions;
}

// ── FallbackProviderChain ─────────────────────────────────────────────────────

export class FallbackProviderChain implements IProviderAdapter {
  readonly provider: string;
  private readonly links: ChainLink[];
  private readonly breakers: CircuitBreaker[];

  constructor(chainName: string, links: ChainLink[]) {
    if (links.length === 0) throw new Error('FallbackProviderChain requires at least one link');
    this.provider = chainName;
    this.links = links;
    this.breakers = links.map(
      (l, i) => new CircuitBreaker(`${chainName}[${i}]:${l.adapter.provider}`, l.breakerOpts)
    );
  }

  async complete(
    messages: GatewayMessage[],
    _model: string,
    _token: string,
    opts: CompletionOptions
  ): Promise<CompletionResult> {
    return this.tryLinks(async (link, breaker) => {
      const result = await link.adapter.complete(messages, link.model, link.token, opts);
      breaker.recordSuccess();
      return result;
    });
  }

  async stream(
    messages: GatewayMessage[],
    _model: string,
    _token: string,
    opts: CompletionOptions,
    onChunk: (chunk: string) => void
  ): Promise<CompletionResult> {
    return this.tryLinks(async (link, breaker) => {
      const result = await link.adapter.stream(messages, link.model, link.token, opts, onChunk);
      breaker.recordSuccess();
      return result;
    });
  }

  /**
   * Extended method for GuardianAngle M_G path.
   * Duck-types the winning adapter's completeWithLogprobs() if available,
   * otherwise falls back to complete() without logprobs.
   */
  async completeWithLogprobs(
    messages: GatewayMessage[],
    _model: string,
    opts: CompletionOptions = {}
  ): Promise<OllamaExtendedResult> {
    return this.tryLinks(async (link, breaker) => {
      // Duck-type: prefer completeWithLogprobs if the adapter has it
      const adapterAny = link.adapter as unknown as Record<string, unknown>;
      if (typeof adapterAny['completeWithLogprobs'] === 'function') {
        const fn = adapterAny['completeWithLogprobs'] as (
          messages: GatewayMessage[],
          model: string,
          opts: CompletionOptions
        ) => Promise<OllamaExtendedResult>;
        const result = await fn.call(link.adapter, messages, link.model, opts);
        breaker.recordSuccess();
        return result;
      }
      const result = await link.adapter.complete(messages, link.model, link.token, opts);
      breaker.recordSuccess();
      return result as OllamaExtendedResult;
    });
  }

  /** Expose breaker states for diagnostics / Canvas health panel. */
  getBreakerStates(): Array<{ name: string; state: string }> {
    return this.breakers.map(b => ({ name: b.name, state: b.getState() }));
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private async tryLinks<T>(
    fn: (link: ChainLink, breaker: CircuitBreaker) => Promise<T>
  ): Promise<T> {
    const errors: string[] = [];

    for (let i = 0; i < this.links.length; i++) {
      const link = this.links[i]!;
      const breaker = this.breakers[i]!;

      if (!breaker.isAvailable()) {
        errors.push(`${link.adapter.provider}:${link.model} — circuit OPEN (skipped)`);
        continue;
      }

      try {
        return await fn(link, breaker);
      } catch (err) {
        breaker.recordFailure();
        errors.push(`${link.adapter.provider}:${link.model} — ${(err as Error).message}`);
      }
    }

    throw new Error(
      `FallbackProviderChain "${this.provider}" exhausted all links:\n` +
      errors.map((e, i) => `  [${i}] ${e}`).join('\n')
    );
  }
}
