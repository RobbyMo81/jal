// src/apex/auth/ClaudeAdapter.ts — Anthropic Claude provider adapter
//
// Implements IProviderAdapter against the Anthropic /v1/messages API.
// Uses fetch + SSE streaming (text/event-stream). No Anthropic SDK — raw HTTP.
// Token (API key) is passed in from ProviderGateway via AuthManager.

import { IProviderAdapter } from './ProviderGateway';
import { GatewayMessage, CompletionOptions, CompletionResult } from '../types';

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface ClaudeRequest {
  model: string;
  max_tokens: number;
  messages: ClaudeMessage[];
  system?: string;
  temperature?: number;
  stream?: boolean;
}

interface ClaudeResponse {
  id: string;
  model: string;
  content: Array<{ type: string; text: string }>;
  usage: { input_tokens: number; output_tokens: number };
  stop_reason: string;
}

// ── ClaudeAdapter ─────────────────────────────────────────────────────────────

export class ClaudeAdapter implements IProviderAdapter {
  readonly provider = 'claude';

  async complete(
    messages: GatewayMessage[],
    model: string,
    token: string,
    opts: CompletionOptions
  ): Promise<CompletionResult> {
    const { system, chatMessages } = splitSystemMessage(messages);
    const body: ClaudeRequest = {
      model,
      max_tokens: opts.max_tokens ?? 4096,
      messages: chatMessages,
      temperature: opts.temperature ?? 0.7,
      stream: false,
    };
    if (system) body.system = system;

    const response = await fetch(CLAUDE_API_URL, {
      method: 'POST',
      headers: buildHeaders(token),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Claude API ${response.status}: ${text}`);
    }

    const data = await response.json() as ClaudeResponse;
    const content = data.content.map(b => b.text).join('');

    return {
      content,
      model: data.model,
      provider: 'claude',
      usage: data.usage,
    };
  }

  async stream(
    messages: GatewayMessage[],
    model: string,
    token: string,
    opts: CompletionOptions,
    onChunk: (chunk: string) => void
  ): Promise<CompletionResult> {
    const { system, chatMessages } = splitSystemMessage(messages);
    const body: ClaudeRequest = {
      model,
      max_tokens: opts.max_tokens ?? 4096,
      messages: chatMessages,
      temperature: opts.temperature ?? 0.7,
      stream: true,
    };
    if (system) body.system = system;

    const response = await fetch(CLAUDE_API_URL, {
      method: 'POST',
      headers: buildHeaders(token),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Claude API ${response.status}: ${text}`);
    }

    if (!response.body) throw new Error('Claude stream body is null');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullContent = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let finalModel = model;

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
            if (evt['type'] === 'content_block_delta') {
              const delta = (evt['delta'] as Record<string, unknown> | undefined);
              const text = delta?.['text'] as string | undefined;
              if (text) { fullContent += text; onChunk(text); }
            } else if (evt['type'] === 'message_start') {
              const msg = evt['message'] as Record<string, unknown> | undefined;
              const usage = msg?.['usage'] as Record<string, number> | undefined;
              if (usage) inputTokens = usage['input_tokens'] ?? 0;
              const m = msg?.['model'] as string | undefined;
              if (m) finalModel = m;
            } else if (evt['type'] === 'message_delta') {
              const usage = evt['usage'] as Record<string, number> | undefined;
              if (usage) outputTokens = usage['output_tokens'] ?? 0;
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
      provider: 'claude',
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': ANTHROPIC_VERSION,
  };
}

function splitSystemMessage(messages: GatewayMessage[]): {
  system: string | undefined;
  chatMessages: ClaudeMessage[];
} {
  let system: string | undefined;
  const chatMessages: ClaudeMessage[] = [];

  for (const m of messages) {
    if (m.role === 'system') {
      system = system ? system + '\n\n' + m.content : m.content;
    } else if (m.role === 'user' || m.role === 'assistant') {
      chatMessages.push({ role: m.role, content: m.content });
    }
  }

  return { system, chatMessages };
}
