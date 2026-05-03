// src/apex/auth/OpenAIAdapter.ts — OpenAI (and compatible) provider adapter
//
// Implements IProviderAdapter against /v1/chat/completions.
// Supports SSE streaming with data: [DONE] sentinel.
// Token (API key) is passed in as Bearer authorization.
// Set OPENAI_BASE_URL to point at compatible endpoints (e.g. local LM Studio).

import { IProviderAdapter } from './ProviderGateway';
import { GatewayMessage, CompletionOptions, CompletionResult } from '../types';

const DEFAULT_BASE = 'https://api.openai.com';

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
}

interface OpenAIResponse {
  id: string;
  model: string;
  choices: Array<{
    message: { role: string; content: string };
    finish_reason: string;
  }>;
  usage: { prompt_tokens: number; completion_tokens: number };
}

// ── OpenAIAdapter ─────────────────────────────────────────────────────────────

export class OpenAIAdapter implements IProviderAdapter {
  readonly provider = 'openai';
  private readonly baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = (baseUrl ?? process.env['OPENAI_BASE_URL'] ?? DEFAULT_BASE)
      .replace(/\/$/, '');
  }

  async complete(
    messages: GatewayMessage[],
    model: string,
    token: string,
    opts: CompletionOptions
  ): Promise<CompletionResult> {
    const body: OpenAIRequest = {
      model,
      messages: messages as OpenAIMessage[],
      temperature: opts.temperature ?? 0.7,
      max_tokens: opts.max_tokens ?? 4096,
      stream: false,
    };

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`OpenAI API ${response.status}: ${text}`);
    }

    const data = await response.json() as OpenAIResponse;
    const choice = data.choices[0];
    if (!choice) throw new Error('OpenAI returned no choices');

    return {
      content: choice.message.content,
      model: data.model,
      provider: 'openai',
      usage: {
        input_tokens: data.usage.prompt_tokens,
        output_tokens: data.usage.completion_tokens,
      },
    };
  }

  async stream(
    messages: GatewayMessage[],
    model: string,
    token: string,
    opts: CompletionOptions,
    onChunk: (chunk: string) => void
  ): Promise<CompletionResult> {
    const body: OpenAIRequest = {
      model,
      messages: messages as OpenAIMessage[],
      temperature: opts.temperature ?? 0.7,
      max_tokens: opts.max_tokens ?? 4096,
      stream: true,
    };

    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`OpenAI API ${response.status}: ${text}`);
    }

    if (!response.body) throw new Error('OpenAI stream body is null');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullContent = '';
    let finalModel = model;
    let inputTokens = 0;
    let outputTokens = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;

        if (trimmed.startsWith('data: ')) {
          try {
            const evt = JSON.parse(trimmed.slice(6)) as Record<string, unknown>;
            const evtModel = evt['model'] as string | undefined;
            if (evtModel) finalModel = evtModel;

            const choices = evt['choices'] as Array<Record<string, unknown>> | undefined;
            const delta = choices?.[0]?.['delta'] as Record<string, unknown> | undefined;
            const text = delta?.['content'] as string | undefined;
            if (text) { fullContent += text; onChunk(text); }

            // usage appears on final chunk for some providers
            const usage = evt['usage'] as Record<string, number> | undefined;
            if (usage) {
              inputTokens = usage['prompt_tokens'] ?? inputTokens;
              outputTokens = usage['completion_tokens'] ?? outputTokens;
            }
          } catch {
            // malformed SSE line — skip
          }
        }
      }
    }

    return {
      content: fullContent,
      model: finalModel,
      provider: 'openai',
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    };
  }
}
