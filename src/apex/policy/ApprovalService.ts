// Co-authored by FORGE (Session: forge-20260324215726-1658598)
// src/apex/policy/ApprovalService.ts — JAL-003 Tier 2 approval token management
//
// Approval tokens are single-use and short-lived (TOKEN_TTL_MS = 5 minutes).
// Token lifecycle:
//   1. requestApproval() creates a token and returns a Promise.
//   2. The caller receives the token via onApprovalRequired callback.
//   3. The human operator calls resolve(tokenId, true/false).
//   4. The Promise resolves; classify() returns the final TierDecision.
//   5. Token is removed from pending map — it cannot be reused.
//
// Context integrity: context_hash is a SHA-256 (truncated) of the action +
// sorted context. If anyone tries to reuse a token for a different command,
// the caller should verify context_hash matches before resolving.

import { randomUUID, createHash } from 'crypto';
import { ApprovalToken, PolicyTier } from '../types';

export const TOKEN_TTL_MS = 5 * 60 * 1_000; // 5 minutes

// ── Internal pending record ───────────────────────────────────────────────────

interface PendingApproval {
  token: ApprovalToken;
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ── ApprovalService ───────────────────────────────────────────────────────────

export class ApprovalService {
  private readonly pending = new Map<string, PendingApproval>();

  /**
   * Create a single-use approval token and return a Promise that resolves
   * once the operator calls resolve() or the token expires.
   *
   * @param action   Dot-namespaced action string (e.g. "shell.exec")
   * @param context  Execution context — used to compute context_hash
   * @param tier     Must be 2 (Tier 2 is the only approval-gated tier)
   * @param reason   Human-readable reason surfaced to the approval UI
   *
   * @returns token  The approval token to hand to onApprovalRequired.
   * @returns promise Resolves with true if approved, false if denied/expired.
   */
  requestApproval(
    action: string,
    context: Record<string, unknown>,
    tier: PolicyTier,
    reason: string
  ): { token: ApprovalToken; promise: Promise<boolean> } {
    const id = randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + TOKEN_TTL_MS);

    const token: ApprovalToken = {
      id,
      action,
      context_hash: this.hashContext(action, context),
      tier,
      reason,
      status: 'pending',
      created_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
    };

    const promise = new Promise<boolean>((resolvePromise) => {
      const timer = setTimeout(() => {
        const entry = this.pending.get(id);
        if (entry) {
          entry.token.status = 'expired';
          this.pending.delete(id);
          resolvePromise(false);
        }
      }, TOKEN_TTL_MS);

      this.pending.set(id, { token, resolve: resolvePromise, timer });
    });

    return { token, promise };
  }

  /**
   * Resolve a pending approval token.
   * This is the only way to unblock a Tier 2 classify() call.
   * Calling resolve() a second time on the same tokenId is a no-op.
   *
   * @param tokenId  UUID from ApprovalToken.id
   * @param approved true = operator approved; false = operator denied
   * @returns true if the token was found and resolved; false if not found.
   */
  resolve(tokenId: string, approved: boolean): boolean {
    const entry = this.pending.get(tokenId);
    if (!entry) return false;

    clearTimeout(entry.timer);
    entry.token.status = approved ? 'approved' : 'denied';
    this.pending.delete(tokenId);
    entry.resolve(approved);
    return true;
  }

  /** True if the given token is still pending resolution. */
  isPending(tokenId: string): boolean {
    return this.pending.has(tokenId);
  }

  /** Return a snapshot of all currently pending tokens. */
  getPendingTokens(): ReadonlyArray<Readonly<ApprovalToken>> {
    return Array.from(this.pending.values()).map(e => e.token);
  }

  // ── Private ───────────────────────────────────────────────────────────────

  /**
   * Deterministic hash of action + context so a token cannot be reused for
   * a different action than the one that requested approval.
   */
  private hashContext(action: string, context: Record<string, unknown>): string {
    const sorted = JSON.stringify(
      Object.fromEntries(
        [['action', action], ...Object.entries(context)].sort(([a], [b]) => a.localeCompare(b))
      )
    );
    return createHash('sha256').update(sorted).digest('hex').slice(0, 16);
  }
}
