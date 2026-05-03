// src/apex/auth/GeminiAdapter.ts — Google Gemini provider adapter
//
// Implements IProviderAdapter against Google Generative AI REST API.
// Uses generateContent (non-streaming) — onChunk receives the full response
// as a single emission so stream() is functionally equivalent to complete().
// Token (API key) is passed via AuthManager.

import { IProviderAdapter } from './ProviderGateway';
import { GatewayMessage, CompletionOptions, CompletionResult } from '../types';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

interface GeminiPart { text: string }
interface GeminiContent { role: 'user' | 'model'; parts: GeminiPart[] }

interface GeminiRequest {
  contents: GeminiContent[];
  systemInstruction?: { parts: GeminiPart[] };
  generationConfig?: {
    temperature?: number;
    maxOutputTokens?: number;
  };
}

interface GeminiResponse {
  candidates: Array<{
    content: { parts: GeminiPart[]; role: string };
    finishReason: string;
  }>;
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
  };
  modelVersion?: string;
}

// ── GeminiAdapter ─────────────────────────────────────────────────────────────

export class GeminiAdapter implements IProviderAdapter {
  readonly provider = 'gemini';

  async complete(
    messages: GatewayMessage[],
    model: string,
    token: string,
    opts: CompletionOptions
  ): Promise<CompletionResult> {
    return this._generate(messages, model, token, opts);
  }

  async stream(
    messages: GatewayMessage[],
    model: string,
    token: string,
    opts: CompletionOptions,
    onChunk: (chunk: string) => void
  ): Promise<CompletionResult> {
    const result = await this._generate(messages, model, token, opts);
    onChunk(result.content);
    return result;
  }

  private async _generate(
    messages: GatewayMessage[],
    model: string,
    apiKey: string,
    opts: CompletionOptions
  ): Promise<CompletionResult> {
    const { systemInstruction, contents } = buildGeminiPayload(messages);

    const body: GeminiRequest = {
      contents,
      generationConfig: {
        temperature: opts.temperature ?? 0.7,
        maxOutputTokens: opts.max_tokens ?? 4096,
      },
    };
    if (systemInstruction) body.systemInstruction = systemInstruction;

    const url = `${GEMINI_BASE}/${model}:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Gemini API ${response.status}: ${text}`);
    }

    const data = await response.json() as GeminiResponse;
    const candidate = data.candidates[0];
    if (!candidate) throw new Error('Gemini returned no candidates');

    const content = candidate.content.parts.map(p => p.text).join('');

    return {
      content,
      model: data.modelVersion ?? model,
      provider: 'gemini',
      usage: {
        input_tokens: data.usageMetadata?.promptTokenCount ?? 0,
        output_tokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      },
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildGeminiPayload(messages: GatewayMessage[]): {
  systemInstruction: { parts: GeminiPart[] } | undefined;
  contents: GeminiContent[];
} {
  let systemText = '';
  const contents: GeminiContent[] = [];

  for (const m of messages) {
    if (m.role === 'system') {
      systemText = systemText ? systemText + '\n\n' + m.content : m.content;
    } else {
      // Gemini uses 'model' instead of 'assistant'
      const role: 'user' | 'model' = m.role === 'assistant' ? 'model' : 'user';
      contents.push({ role, parts: [{ text: m.content }] });
    }
  }

  // Gemini requires alternating user/model turns — ensure first turn is user
  if (contents.length === 0) {
    contents.push({ role: 'user', parts: [{ text: '' }] });
  }

  return {
    systemInstruction: systemText ? { parts: [{ text: systemText }] } : undefined,
    contents,
  };
}
