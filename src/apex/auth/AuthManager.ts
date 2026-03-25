// Co-authored by FORGE (Session: forge-20260325062232-1899997)
// src/apex/auth/AuthManager.ts — JAL-005 Provider-isolated session lifecycle manager
//
// Safety guarantees enforced here:
//   1. Tokens are ONLY stored in the IKeychain abstraction (OS-backed in production).
//   2. Provider isolation: getToken('anthropic') can never return an openai token.
//   3. Logout removes ALL session artifacts — no dangling references.
//   4. Expired tokens trigger re-login prompt; refresh is attempted first if possible.
//
// Provider name validation: must match /^[a-z][a-z0-9-]*$/ to prevent injection
// into keychain service/account strings.

import { IKeychain } from './IKeychain';
import { IAuditLog } from '../policy/AuditLog';
import { AuthSession, AuthLoginResult, AuthMethod, AuthStatus } from '../types';

// ── Constants ──────────────────────────────────────────────────────────────────

const KEYCHAIN_SERVICE = 'apex-auth';
const PROVIDER_INDEX_ACCOUNT = '__providers__';
const PROVIDER_NAME_RE = /^[a-z][a-z0-9-]*$/;

// ── Internal stored shape — never exposed directly ────────────────────────────

interface StoredSession {
  token: string;
  refresh_token?: string;
  expires_at: string | null;
  auth_method: AuthMethod;
  created_at: string;
}

// ── AuthManager ───────────────────────────────────────────────────────────────

export interface AuthManagerOptions {
  keychain: IKeychain;
  audit: IAuditLog;
}

export class AuthManager {
  private readonly keychain: IKeychain;
  private readonly audit: IAuditLog;

  constructor(opts: AuthManagerOptions) {
    this.keychain = opts.keychain;
    this.audit = opts.audit;
  }

  // ── Login ──────────────────────────────────────────────────────────────────

  /**
   * Authenticate with a provider and store the session in OS keychain.
   * Provider isolation: each provider's session is stored under a distinct
   * keychain account key; a token for provider A cannot satisfy a getToken(B) call.
   */
  async login(
    provider: string,
    token: string,
    opts: {
      expires_at?: string | null;
      refresh_token?: string;
      auth_method: AuthMethod;
    }
  ): Promise<AuthLoginResult> {
    if (!PROVIDER_NAME_RE.test(provider)) {
      return {
        status: 'failure',
        provider,
        expires_at: null,
        message: `Invalid provider name "${provider}". Must match /^[a-z][a-z0-9-]*$/.`,
      };
    }

    const session: StoredSession = {
      token,
      refresh_token: opts.refresh_token,
      expires_at: opts.expires_at ?? null,
      auth_method: opts.auth_method,
      created_at: new Date().toISOString(),
    };

    // Write to OS keychain — never plaintext
    await this.keychain.set(
      KEYCHAIN_SERVICE,
      `session:${provider}`,
      JSON.stringify(session)
    );

    await this.registerProvider(provider);

    this.audit.write({
      timestamp: new Date().toISOString(),
      level: 'info',
      service: 'auth-manager',
      message: 'Login successful',
      action: 'auth.login',
      provider,
      auth_method: opts.auth_method,
    });

    return {
      status: 'success',
      provider,
      expires_at: session.expires_at,
      message: `Authenticated with ${provider} via ${opts.auth_method}.`,
    };
  }

  // ── Session retrieval ──────────────────────────────────────────────────────

  /**
   * Get the public session record for a provider (no raw token exposed).
   * Returns null if no session exists for this provider.
   */
  async getSession(provider: string): Promise<AuthSession | null> {
    const stored = await this.loadStored(provider);
    if (!stored) return null;

    return {
      provider,
      status: this.computeStatus(stored),
      expires_at: stored.expires_at,
      auth_method: stored.auth_method,
      created_at: stored.created_at,
    };
  }

  /**
   * Get the raw token for a provider — for use by ProviderGateway only.
   * Returns null if unauthenticated or expired without a refresh path.
   * Triggers token refresh if refresh_token is available.
   */
  async getToken(provider: string): Promise<string | null> {
    const stored = await this.loadStored(provider);
    if (!stored) return null;

    if (this.isExpired(stored)) {
      if (stored.refresh_token) {
        return this.doRefresh(provider, stored);
      }
      // Expired, no refresh path — caller must prompt re-login
      this.audit.write({
        timestamp: new Date().toISOString(),
        level: 'warn',
        service: 'auth-manager',
        message: 'Token expired — re-login required',
        action: 'auth.token_expired',
        provider,
      });
      return null;
    }

    return stored.token;
  }

  // ── Refresh ────────────────────────────────────────────────────────────────

  /**
   * Attempt to refresh an expired token.
   * Phase 1: stub — refresh is provider-specific and implemented per-adapter.
   * Returns null and logs a warning so callers know to prompt re-login.
   */
  async refresh(provider: string): Promise<string | null> {
    const stored = await this.loadStored(provider);
    if (!stored?.refresh_token) return null;
    return this.doRefresh(provider, stored);
  }

  // ── Logout ─────────────────────────────────────────────────────────────────

  /**
   * Remove all session artifacts for a provider.
   * After this call, getToken(provider) returns null and inference is blocked.
   */
  async logout(provider: string): Promise<void> {
    await this.keychain.delete(KEYCHAIN_SERVICE, `session:${provider}`);
    await this.deregisterProvider(provider);

    this.audit.write({
      timestamp: new Date().toISOString(),
      level: 'info',
      service: 'auth-manager',
      message: 'Logout complete — session artifacts removed',
      action: 'auth.logout',
      provider,
    });
  }

  /**
   * Log out ALL providers. Blocks all inference until re-authentication.
   */
  async logoutAll(): Promise<void> {
    const providers = await this.getRegisteredProviders();
    for (const provider of providers) {
      await this.logout(provider);
    }
  }

  // ── Provider registry ──────────────────────────────────────────────────────

  /** List all providers that have (or had) an active session. */
  async getRegisteredProviders(): Promise<string[]> {
    const raw = await this.keychain.get(KEYCHAIN_SERVICE, PROVIDER_INDEX_ACCOUNT);
    if (!raw) return [];
    try {
      return JSON.parse(raw) as string[];
    } catch {
      return [];
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async loadStored(provider: string): Promise<StoredSession | null> {
    const raw = await this.keychain.get(KEYCHAIN_SERVICE, `session:${provider}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as StoredSession;
    } catch {
      return null;
    }
  }

  private computeStatus(stored: StoredSession): AuthStatus {
    if (this.isExpired(stored)) return 'expired';
    return 'authenticated';
  }

  private isExpired(stored: StoredSession): boolean {
    if (!stored.expires_at) return false; // null = never expires
    return new Date(stored.expires_at) <= new Date();
  }

  /**
   * Phase 1 stub: real refresh requires provider-specific OAuth endpoints.
   * Future: delegate to IProviderAdapter.refresh(refreshToken).
   */
  private async doRefresh(provider: string, _stored: StoredSession): Promise<string | null> {
    this.audit.write({
      timestamp: new Date().toISOString(),
      level: 'warn',
      service: 'auth-manager',
      message: 'Token refresh not yet implemented — re-login required',
      action: 'auth.refresh_failed',
      provider,
    });
    return null;
  }

  private async registerProvider(provider: string): Promise<void> {
    const existing = await this.getRegisteredProviders();
    if (!existing.includes(provider)) {
      await this.keychain.set(
        KEYCHAIN_SERVICE,
        PROVIDER_INDEX_ACCOUNT,
        JSON.stringify([...existing, provider])
      );
    }
  }

  private async deregisterProvider(provider: string): Promise<void> {
    const existing = await this.getRegisteredProviders();
    await this.keychain.set(
      KEYCHAIN_SERVICE,
      PROVIDER_INDEX_ACCOUNT,
      JSON.stringify(existing.filter(p => p !== provider))
    );
  }
}
