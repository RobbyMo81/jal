// Co-authored by FORGE (Session: forge-20260325062232-1899997)
// tests/auth/AuthManager.test.ts — JAL-005 AuthManager unit tests
//
// Uses MemoryKeychain (test double) — never hits OS keychain or any network.

import { AuthManager } from '../../src/apex/auth/AuthManager';
import { MemoryKeychain } from '../../src/apex/auth/MemoryKeychain';
import { NoOpAuditLog } from '../../src/apex/policy/AuditLog';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeManager(): { manager: AuthManager; keychain: MemoryKeychain } {
  const keychain = new MemoryKeychain();
  const audit = new NoOpAuditLog();
  const manager = new AuthManager({ keychain, audit });
  return { manager, keychain };
}

function futureIso(offsetMs = 3_600_000): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function pastIso(offsetMs = 3_600_000): string {
  return new Date(Date.now() - offsetMs).toISOString();
}

// ── Login ─────────────────────────────────────────────────────────────────────

describe('AuthManager.login', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns success and stores session for valid provider', async () => {
    const { manager } = makeManager();
    const result = await manager.login('anthropic', 'tok-abc', {
      auth_method: 'cli-hook',
      expires_at: futureIso(),
    });

    expect(result.status).toBe('success');
    expect(result.provider).toBe('anthropic');
    expect(result.expires_at).not.toBeNull();
  });

  it('rejects invalid provider names', async () => {
    const { manager } = makeManager();
    const result = await manager.login('ANTHROPIC', 'tok', { auth_method: 'cli-hook' });
    expect(result.status).toBe('failure');
    expect(result.message).toMatch(/Invalid provider name/);
  });

  it('rejects provider names with spaces', async () => {
    const { manager } = makeManager();
    const result = await manager.login('open ai', 'tok', { auth_method: 'api-key' });
    expect(result.status).toBe('failure');
  });

  it('handles null expires_at (non-expiring token)', async () => {
    const { manager } = makeManager();
    const result = await manager.login('openai', 'tok-xyz', {
      auth_method: 'api-key',
      expires_at: null,
    });
    expect(result.status).toBe('success');
    expect(result.expires_at).toBeNull();
  });

  it('registers provider in provider index after login', async () => {
    const { manager } = makeManager();
    await manager.login('anthropic', 'tok', { auth_method: 'cli-hook' });

    const providers = await manager.getRegisteredProviders();
    expect(providers).toContain('anthropic');
  });

  it('does not duplicate provider in index on repeated login', async () => {
    const { manager } = makeManager();
    await manager.login('anthropic', 'tok1', { auth_method: 'cli-hook' });
    await manager.login('anthropic', 'tok2', { auth_method: 'cli-hook' });

    const providers = await manager.getRegisteredProviders();
    expect(providers.filter(p => p === 'anthropic')).toHaveLength(1);
  });
});

// ── getSession ────────────────────────────────────────────────────────────────

describe('AuthManager.getSession', () => {
  it('returns null for unknown provider', async () => {
    const { manager } = makeManager();
    const session = await manager.getSession('anthropic');
    expect(session).toBeNull();
  });

  it('returns authenticated session for valid unexpired token', async () => {
    const { manager } = makeManager();
    await manager.login('anthropic', 'tok', {
      auth_method: 'cli-hook',
      expires_at: futureIso(),
    });

    const session = await manager.getSession('anthropic');
    expect(session).not.toBeNull();
    expect(session!.status).toBe('authenticated');
    expect(session!.provider).toBe('anthropic');
    expect(session!.auth_method).toBe('cli-hook');
  });

  it('returns expired status for expired token', async () => {
    const { manager } = makeManager();
    await manager.login('anthropic', 'tok', {
      auth_method: 'api-key',
      expires_at: pastIso(),
    });

    const session = await manager.getSession('anthropic');
    expect(session!.status).toBe('expired');
  });

  it('returns authenticated status for non-expiring token (null expires_at)', async () => {
    const { manager } = makeManager();
    await manager.login('openai', 'tok', { auth_method: 'api-key', expires_at: null });

    const session = await manager.getSession('openai');
    expect(session!.status).toBe('authenticated');
  });

  it('does NOT expose raw token via getSession', async () => {
    const { manager } = makeManager();
    await manager.login('anthropic', 'super-secret-tok', { auth_method: 'cli-hook' });

    const session = await manager.getSession('anthropic');
    // AuthSession type has no token field — this is a compile-time + runtime check
    expect(JSON.stringify(session)).not.toContain('super-secret-tok');
  });
});

// ── getToken ──────────────────────────────────────────────────────────────────

describe('AuthManager.getToken', () => {
  it('returns token for valid unexpired session', async () => {
    const { manager } = makeManager();
    await manager.login('anthropic', 'tok-abc', {
      auth_method: 'cli-hook',
      expires_at: futureIso(),
    });

    const token = await manager.getToken('anthropic');
    expect(token).toBe('tok-abc');
  });

  it('returns null for unknown provider', async () => {
    const { manager } = makeManager();
    expect(await manager.getToken('anthropic')).toBeNull();
  });

  it('returns null for expired token without refresh_token', async () => {
    const { manager } = makeManager();
    await manager.login('anthropic', 'tok', {
      auth_method: 'api-key',
      expires_at: pastIso(),
    });

    const token = await manager.getToken('anthropic');
    expect(token).toBeNull();
  });

  it('returns null for expired token even with refresh_token (Phase 1 stub)', async () => {
    const { manager } = makeManager();
    await manager.login('anthropic', 'tok', {
      auth_method: 'oauth',
      expires_at: pastIso(),
      refresh_token: 'refresh-tok',
    });

    // Phase 1: refresh stub always returns null
    const token = await manager.getToken('anthropic');
    expect(token).toBeNull();
  });
});

// ── Provider isolation ────────────────────────────────────────────────────────

describe('AuthManager provider isolation', () => {
  it('anthropic token cannot be retrieved as openai token', async () => {
    const { manager } = makeManager();
    await manager.login('anthropic', 'anthropic-tok', {
      auth_method: 'cli-hook',
      expires_at: futureIso(),
    });

    const token = await manager.getToken('openai');
    expect(token).toBeNull();
  });

  it('separate sessions for anthropic and openai are independent', async () => {
    const { manager } = makeManager();
    await manager.login('anthropic', 'tok-anthropic', {
      auth_method: 'cli-hook',
      expires_at: futureIso(),
    });
    await manager.login('openai', 'tok-openai', {
      auth_method: 'api-key',
      expires_at: futureIso(),
    });

    expect(await manager.getToken('anthropic')).toBe('tok-anthropic');
    expect(await manager.getToken('openai')).toBe('tok-openai');
  });

  it('overwriting anthropic session does not affect openai session', async () => {
    const { manager } = makeManager();
    await manager.login('anthropic', 'tok-old', {
      auth_method: 'cli-hook',
      expires_at: futureIso(),
    });
    await manager.login('openai', 'tok-openai', {
      auth_method: 'api-key',
      expires_at: futureIso(),
    });
    await manager.login('anthropic', 'tok-new', {
      auth_method: 'cli-hook',
      expires_at: futureIso(),
    });

    expect(await manager.getToken('anthropic')).toBe('tok-new');
    expect(await manager.getToken('openai')).toBe('tok-openai');
  });
});

// ── Logout ────────────────────────────────────────────────────────────────────

describe('AuthManager.logout', () => {
  it('removes session — getToken returns null after logout', async () => {
    const { manager } = makeManager();
    await manager.login('anthropic', 'tok', {
      auth_method: 'cli-hook',
      expires_at: futureIso(),
    });

    await manager.logout('anthropic');

    expect(await manager.getToken('anthropic')).toBeNull();
    expect(await manager.getSession('anthropic')).toBeNull();
  });

  it('removes provider from registry after logout', async () => {
    const { manager } = makeManager();
    await manager.login('anthropic', 'tok', { auth_method: 'cli-hook' });
    await manager.logout('anthropic');

    const providers = await manager.getRegisteredProviders();
    expect(providers).not.toContain('anthropic');
  });

  it('logoutAll removes all sessions', async () => {
    const { manager } = makeManager();
    await manager.login('anthropic', 'tok-a', {
      auth_method: 'cli-hook',
      expires_at: futureIso(),
    });
    await manager.login('openai', 'tok-o', {
      auth_method: 'api-key',
      expires_at: futureIso(),
    });

    await manager.logoutAll();

    expect(await manager.getToken('anthropic')).toBeNull();
    expect(await manager.getToken('openai')).toBeNull();
    expect(await manager.getRegisteredProviders()).toHaveLength(0);
  });

  it('logout on unknown provider is a no-op (no throw)', async () => {
    const { manager } = makeManager();
    await expect(manager.logout('anthropic')).resolves.not.toThrow();
  });

  it('logout does not affect other providers', async () => {
    const { manager } = makeManager();
    await manager.login('anthropic', 'tok-a', {
      auth_method: 'cli-hook',
      expires_at: futureIso(),
    });
    await manager.login('openai', 'tok-o', {
      auth_method: 'api-key',
      expires_at: futureIso(),
    });

    await manager.logout('anthropic');

    expect(await manager.getToken('openai')).toBe('tok-o');
  });
});

// ── Provider registry ─────────────────────────────────────────────────────────

describe('AuthManager.getRegisteredProviders', () => {
  it('returns empty array when no providers registered', async () => {
    const { manager } = makeManager();
    expect(await manager.getRegisteredProviders()).toEqual([]);
  });

  it('tracks multiple providers', async () => {
    const { manager } = makeManager();
    await manager.login('anthropic', 'tok', { auth_method: 'cli-hook' });
    await manager.login('openai', 'tok', { auth_method: 'api-key' });

    const providers = await manager.getRegisteredProviders();
    expect(providers).toContain('anthropic');
    expect(providers).toContain('openai');
    expect(providers).toHaveLength(2);
  });
});
