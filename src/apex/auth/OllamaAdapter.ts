// Co-authored by Apex Wakening Build
// src/apex/auth/OllamaAdapter.ts — First-class Ollama provider adapter
//
// Implements IProviderAdapter for Ollama (local inference, no auth required).
// Also exposes completeWithLogprobs() for GuardianAngle entropy monitoring.
//
// Token param from IProviderAdapter is intentionally unused — Ollama is local.
// Set OLLAMA_BASE_URL to override the default (http://localhost:11434).

import { IProviderAdapter } from './ProviderGateway';
import { GatewayMessage, CompletionOptions, CompletionResult } from '../types';

// ── Interface for adapters that support logprob-enriched completions ─────────

export interface IAdapterWithLogprobs {
  completeWithLogprobs(
    messages: GatewayMessage[],
    model: string,
    opts?: CompletionOptions
  ): Promise<OllamaExtendedResult>;
}

// ── Extended result for GuardianAngle internal use ────────────────────────────

export interface OllamaTokenLogprob {
  token: string;
  /** Natural log probability: log(P(token | context)). Range: (-∞, 0]. */
  logprob: number;
}

export interface OllamaExtendedResult extends CompletionResult {
  logprobs?: OllamaTokenLogprob[];
  eval_count?: number;
  prompt_eval_count?: number;
}

// ── Ollama wire types (internal) ──────────────────────────────────────────────

interface OllamaChatPayload {
  model: string;
  messages: Array<{ role: string; content: string }>;
  stream: boolean;
  options?: Record<string, unknown>;
}

interface OllamaChatResponse {
  model: string;
  message: { role: string; content: string };
  done: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
  logprobs?: OllamaTokenLogprob[];
}

interface OllamaChatStreamChunk {
  model: string;
  message?: { role: string; content: string };
  done: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
  logprobs?: OllamaTokenLogprob[];
}

// ── OllamaAdapterOptions ──────────────────────────────────────────────────────

export interface OllamaAdapterOptions {
  /** Ollama server base URL. Defaults to OLLAMA_BASE_URL env or http://localhost:11434. */
  baseUrl?: string;
}

// ── OllamaAdapter ─────────────────────────────────────────────────────────────

export class OllamaAdapter implements IProviderAdapter {
  readonly provider = 'ollama';
  readonly baseUrl: string;

  constructor(opts: OllamaAdapterOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434')
      .replace(/\/$/, '');
  }

  /** Standard IProviderAdapter completion — no logprobs. Token param unused. */
  async complete(
    messages: GatewayMessage[],
    model: string,
    _token: string,
    opts: CompletionOptions
  ): Promise<CompletionResult> {
    const result = await this.completeWithLogprobs(messages, model, opts);
    return { content: result.content, model: result.model, provider: result.provider, usage: result.usage };
  }

  /** Standard IProviderAdapter streaming. Token param unused. */
  async stream(
    messages: GatewayMessage[],
    model: string,
    _token: string,
    opts: CompletionOptions,
    onChunk: (chunk: string) => void
  ): Promise<CompletionResult> {
    const result = await this.streamWithLogprobs(messages, model, opts, onChunk);
    return { content: result.content, model: result.model, provider: result.provider, usage: result.usage };
  }

  /**
   * Extended completion that returns logprobs when Ollama provides them.
   * Used internally by GuardianAngle for entropy assessment.
   */
  async completeWithLogprobs(
    messages: GatewayMessage[],
    model: string,
    opts: CompletionOptions = {}
  ): Promise<OllamaExtendedResult> {
    const payload: OllamaChatPayload = {
      model,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      stream: false,
      options: this.buildOptions(opts, true),
    };

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Ollama API error ${response.status}: ${body}`);
    }

    const data = await response.json() as OllamaChatResponse;

    return {
      content: data.message.content,
      model: data.model,
      provider: 'ollama',
      usage: {
        input_tokens: data.prompt_eval_count ?? 0,
        output_tokens: data.eval_count ?? 0,
      },
      logprobs: data.logprobs,
      eval_count: data.eval_count,
      prompt_eval_count: data.prompt_eval_count,
    };
  }

  /**
   * Extended streaming that collects logprobs from the final done chunk.
   * Used internally by GuardianAngle.
   */
  async streamWithLogprobs(
    messages: GatewayMessage[],
    model: string,
    opts: CompletionOptions = {},
    onChunk: (chunk: string) => void
  ): Promise<OllamaExtendedResult> {
    const payload: OllamaChatPayload = {
      model,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      stream: true,
      options: this.buildOptions(opts, false),
    };

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Ollama API error ${response.status}: ${body}`);
    }

    if (!response.body) {
      throw new Error('Ollama stream response body is null');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullContent = '';
    let lastDoneChunk: OllamaChatStreamChunk | null = null;
    const allLogprobs: OllamaTokenLogprob[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const chunk = JSON.parse(trimmed) as OllamaChatStreamChunk;
        if (chunk.message?.content) {
          fullContent += chunk.message.content;
          onChunk(chunk.message.content);
        }
        if (chunk.logprobs) {
          allLogprobs.push(...chunk.logprobs);
        }
        if (chunk.done) {
          lastDoneChunk = chunk;
        }
      }
    }

    return {
      content: fullContent,
      model: lastDoneChunk?.model ?? model,
      provider: 'ollama',
      usage: {
        input_tokens: lastDoneChunk?.prompt_eval_count ?? 0,
        output_tokens: lastDoneChunk?.eval_count ?? 0,
      },
      logprobs: allLogprobs.length > 0 ? allLogprobs : undefined,
      eval_count: lastDoneChunk?.eval_count,
      prompt_eval_count: lastDoneChunk?.prompt_eval_count,
    };
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private buildOptions(opts: CompletionOptions, requestLogprobs: boolean): Record<string, unknown> {
    const options: Record<string, unknown> = {
      temperature: opts.temperature ?? 0.7,
    };
    if (opts.max_tokens) {
      options['num_predict'] = opts.max_tokens;
    }
    if (requestLogprobs) {
      options['logprobs'] = true;
    }
    return options;
  }
}
