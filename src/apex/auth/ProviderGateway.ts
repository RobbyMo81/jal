// Co-authored by FORGE (Session: forge-20260325062232-1899997)
// src/apex/auth/ProviderGateway.ts — JAL-005 Provider-agnostic inference gateway
//
// Normalises completion, streaming, and error handling across providers.
// Provider and model switches require NO code changes — register new adapters
// at startup via registerAdapter().
//
// Auth injection: gateway calls AuthManager.getToken(provider) before every
// inference call. If the token is null/expired, throws GatewayAuthError with
// a re-login prompt rather than silently failing.

import { AuthManager } from './AuthManager';
import {
  GatewayMessage,
  CompletionOptions,
  CompletionResult,
  ProviderConfig,
} from '../types';

// ── IProviderAdapter ──────────────────────────────────────────────────────────

/**
 * Contract for provider-specific inference backends.
 * Each provider registers one adapter. The gateway delegates to it.
 */
export interface IProviderAdapter {
  readonly provider: string;

  /** Non-streaming completion. */
  complete(
    messages: GatewayMessage[],
    model: string,
    token: string,
    opts: CompletionOptions
  ): Promise<CompletionResult>;

  /**
   * Streaming completion. Calls onChunk for each token as it arrives.
   * Resolves with the full result once streaming is complete.
   */
  stream(
    messages: GatewayMessage[],
    model: string,
    token: string,
    opts: CompletionOptions,
    onChunk: (chunk: string) => void
  ): Promise<CompletionResult>;
}

// ── Gateway errors ────────────────────────────────────────────────────────────

export class GatewayAuthError extends Error {
  constructor(public readonly provider: string) {
    super(
      `Not authenticated with provider "${provider}". ` +
      `Run: apex auth login --provider ${provider} --json`
    );
    this.name = 'GatewayAuthError';
  }
}

export class GatewayProviderError extends Error {
  constructor(public readonly provider: string) {
    super(
      `No adapter registered for provider "${provider}". ` +
      `Register one via ProviderGateway.registerAdapter().`
    );
    this.name = 'GatewayProviderError';
  }
}

// ── ProviderGateway ───────────────────────────────────────────────────────────

export interface ProviderGatewayOptions {
  authManager: AuthManager;
  /** Active provider + model config (from ConfigGuiBridge or stored config). */
  config: ProviderConfig;
}

export class ProviderGateway {
  private readonly adapters = new Map<string, IProviderAdapter>();
  private readonly authManager: AuthManager;
  private config: ProviderConfig;

  constructor(opts: ProviderGatewayOptions) {
    this.authManager = opts.authManager;
    this.config = opts.config;
  }

  /** Register a provider adapter. Overwrites any existing adapter for that provider. */
  registerAdapter(adapter: IProviderAdapter): void {
    this.adapters.set(adapter.provider, adapter);
  }

  /** Switch the active provider+model. No code changes required — just update config. */
  switchConfig(config: ProviderConfig): void {
    this.config = config;
  }

  /** Get the currently active provider config. */
  getConfig(): Readonly<ProviderConfig> {
    return this.config;
  }

  // ── Inference ──────────────────────────────────────────────────────────────

  /**
   * Non-streaming completion through the active provider.
   * Resolves the model from config unless overridden in opts.
   */
  async complete(
    messages: GatewayMessage[],
    opts: CompletionOptions = {}
  ): Promise<CompletionResult> {
    const { adapter, token, model } = await this.resolveContext(opts);
    return adapter.complete(messages, model, token, opts);
  }

  /**
   * Streaming completion through the active provider.
   * onChunk is called for each token fragment as it arrives.
   */
  async stream(
    messages: GatewayMessage[],
    opts: CompletionOptions = {},
    onChunk: (chunk: string) => void
  ): Promise<CompletionResult> {
    const { adapter, token, model } = await this.resolveContext(opts);
    return adapter.stream(messages, model, token, opts, onChunk);
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async resolveContext(
    opts: CompletionOptions
  ): Promise<{ adapter: IProviderAdapter; token: string; model: string }> {
    const provider = this.config.provider;
    const model = opts.model ?? this.config.model;

    const adapter = this.adapters.get(provider);
    if (!adapter) {
      throw new GatewayProviderError(provider);
    }

    const token = await this.authManager.getToken(provider);
    if (!token) {
      throw new GatewayAuthError(provider);
    }

    return { adapter, token, model };
  }
}

// ── StubAdapter — Phase 1 test/dev stand-in ───────────────────────────────────

/**
 * Stub adapter for testing and Phase 1 dev work.
 * Returns canned responses without hitting any external API.
 */
export class StubProviderAdapter implements IProviderAdapter {
  constructor(
    public readonly provider: string,
    private readonly response: string = '[stub response]'
  ) {}

  async complete(
    _messages: GatewayMessage[],
    model: string,
    _token: string,
    _opts: CompletionOptions
  ): Promise<CompletionResult> {
    return {
      content: this.response,
      model,
      provider: this.provider,
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }

  async stream(
    _messages: GatewayMessage[],
    model: string,
    _token: string,
    _opts: CompletionOptions,
    onChunk: (chunk: string) => void
  ): Promise<CompletionResult> {
    // Emit the stub response word-by-word to exercise the streaming path
    for (const word of this.response.split(' ')) {
      onChunk(word + ' ');
    }
    return {
      content: this.response,
      model,
      provider: this.provider,
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }
}
