// Co-authored by FORGE (Session: forge-20260325062232-1899997)
// tests/auth/ProviderGateway.test.ts — JAL-005 ProviderGateway unit tests
//
// Uses MemoryKeychain + StubProviderAdapter — no network calls.

import { AuthManager } from '../../src/apex/auth/AuthManager';
import { MemoryKeychain } from '../../src/apex/auth/MemoryKeychain';
import {
  ProviderGateway,
  StubProviderAdapter,
  GatewayAuthError,
  GatewayProviderError,
} from '../../src/apex/auth/ProviderGateway';
import { NoOpAuditLog } from '../../src/apex/policy/AuditLog';

// ── Helpers ───────────────────────────────────────────────────────────────────

function futureIso(): string {
  return new Date(Date.now() + 3_600_000).toISOString();
}

function makeGateway(provider = 'anthropic', model = 'claude-sonnet-4-6') {
  const keychain = new MemoryKeychain();
  const audit = new NoOpAuditLog();
  const authManager = new AuthManager({ keychain, audit });
  const gateway = new ProviderGateway({
    authManager,
    config: { provider, model },
  });
  gateway.registerAdapter(new StubProviderAdapter('anthropic', 'stub-anthropic'));
  gateway.registerAdapter(new StubProviderAdapter('openai', 'stub-openai'));
  return { gateway, authManager };
}

const MESSAGES = [{ role: 'user' as const, content: 'hello' }];

// ── Auth enforcement ──────────────────────────────────────────────────────────

describe('ProviderGateway auth enforcement', () => {
  beforeEach(() => jest.clearAllMocks());

  it('throws GatewayAuthError if no session exists for active provider', async () => {
    const { gateway } = makeGateway();
    await expect(gateway.complete(MESSAGES)).rejects.toThrow(GatewayAuthError);
  });

  it('GatewayAuthError message includes provider name and re-login hint', async () => {
    const { gateway } = makeGateway();
    await expect(gateway.complete(MESSAGES)).rejects.toThrow(/anthropic/);
    await expect(gateway.complete(MESSAGES)).rejects.toThrow(/apex auth login/);
  });

  it('succeeds when authenticated', async () => {
    const { gateway, authManager } = makeGateway();
    await authManager.login('anthropic', 'tok', {
      auth_method: 'cli-hook',
      expires_at: futureIso(),
    });

    const result = await gateway.complete(MESSAGES);
    expect(result.content).toBe('stub-anthropic');
    expect(result.provider).toBe('anthropic');
  });

  it('throws GatewayAuthError after logout', async () => {
    const { gateway, authManager } = makeGateway();
    await authManager.login('anthropic', 'tok', {
      auth_method: 'cli-hook',
      expires_at: futureIso(),
    });
    await authManager.logout('anthropic');

    await expect(gateway.complete(MESSAGES)).rejects.toThrow(GatewayAuthError);
  });
});

// ── Provider registration ─────────────────────────────────────────────────────

describe('ProviderGateway adapter registration', () => {
  it('throws GatewayProviderError for unregistered provider', async () => {
    const keychain = new MemoryKeychain();
    const audit = new NoOpAuditLog();
    const authManager = new AuthManager({ keychain, audit });
    const gateway = new ProviderGateway({
      authManager,
      config: { provider: 'unknown-provider', model: 'model-x' },
    });

    await authManager.login('unknown-provider', 'tok', {
      auth_method: 'api-key',
      expires_at: futureIso(),
    });

    await expect(gateway.complete(MESSAGES)).rejects.toThrow(GatewayProviderError);
    await expect(gateway.complete(MESSAGES)).rejects.toThrow(/unknown-provider/);
  });

  it('registerAdapter overwrites existing adapter', async () => {
    const { gateway, authManager } = makeGateway();
    await authManager.login('anthropic', 'tok', {
      auth_method: 'cli-hook',
      expires_at: futureIso(),
    });

    gateway.registerAdapter(new StubProviderAdapter('anthropic', 'replaced'));
    const result = await gateway.complete(MESSAGES);
    expect(result.content).toBe('replaced');
  });
});

// ── Provider switch ───────────────────────────────────────────────────────────

describe('ProviderGateway.switchConfig', () => {
  it('routes to new provider after switchConfig', async () => {
    const { gateway, authManager } = makeGateway('anthropic', 'claude-sonnet-4-6');

    await authManager.login('anthropic', 'tok-a', {
      auth_method: 'cli-hook',
      expires_at: futureIso(),
    });
    await authManager.login('openai', 'tok-o', {
      auth_method: 'api-key',
      expires_at: futureIso(),
    });

    const before = await gateway.complete(MESSAGES);
    expect(before.provider).toBe('anthropic');

    gateway.switchConfig({ provider: 'openai', model: 'gpt-4o' });
    const after = await gateway.complete(MESSAGES);
    expect(after.provider).toBe('openai');
    expect(after.content).toBe('stub-openai');
  });

  it('getConfig reflects the active config', () => {
    const { gateway } = makeGateway('anthropic', 'claude-sonnet-4-6');
    expect(gateway.getConfig()).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-6' });

    gateway.switchConfig({ provider: 'openai', model: 'gpt-4o-mini' });
    expect(gateway.getConfig()).toEqual({ provider: 'openai', model: 'gpt-4o-mini' });
  });
});

// ── Streaming ─────────────────────────────────────────────────────────────────

describe('ProviderGateway streaming', () => {
  it('calls onChunk for each fragment', async () => {
    const { gateway, authManager } = makeGateway();
    await authManager.login('anthropic', 'tok', {
      auth_method: 'cli-hook',
      expires_at: futureIso(),
    });

    const chunks: string[] = [];
    const result = await gateway.stream(MESSAGES, {}, (chunk) => chunks.push(chunk));

    expect(chunks.length).toBeGreaterThan(0);
    expect(result.content).toBe('stub-anthropic');
  });

  it('throws GatewayAuthError in stream path when not authenticated', async () => {
    const { gateway } = makeGateway();
    await expect(gateway.stream(MESSAGES, {}, () => {})).rejects.toThrow(GatewayAuthError);
  });
});

// ── Model override ────────────────────────────────────────────────────────────

describe('ProviderGateway model resolution', () => {
  it('uses config model by default', async () => {
    const { gateway, authManager } = makeGateway('anthropic', 'claude-sonnet-4-6');
    await authManager.login('anthropic', 'tok', {
      auth_method: 'cli-hook',
      expires_at: futureIso(),
    });

    const result = await gateway.complete(MESSAGES);
    expect(result.model).toBe('claude-sonnet-4-6');
  });

  it('uses opts.model override when provided', async () => {
    const { gateway, authManager } = makeGateway('anthropic', 'claude-sonnet-4-6');
    await authManager.login('anthropic', 'tok', {
      auth_method: 'cli-hook',
      expires_at: futureIso(),
    });

    const result = await gateway.complete(MESSAGES, { model: 'claude-opus-4-6' });
    expect(result.model).toBe('claude-opus-4-6');
  });
});
