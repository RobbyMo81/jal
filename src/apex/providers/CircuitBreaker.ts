// src/apex/providers/CircuitBreaker.ts — Per-provider circuit breaker
//
// States:
//   CLOSED   — healthy; requests flow through
//   OPEN     — unhealthy; requests are rejected immediately
//   HALF_OPEN — recovery probe; one request allowed through to test health
//
// Opens after failureThreshold failures within failureWindowMs.
// Half-opens automatically after recoveryMs in OPEN state.
// Resets to CLOSED on a successful HALF_OPEN probe.

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface CircuitBreakerOptions {
  /** Number of failures in the window to trip the breaker. Default: 3 */
  failureThreshold?: number;
  /** Rolling window for counting failures (ms). Default: 60_000 */
  failureWindowMs?: number;
  /** Time before transitioning OPEN → HALF_OPEN (ms). Default: 30_000 */
  recoveryMs?: number;
}

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failures: number[] = [];   // timestamps of recent failures
  private openedAt = 0;

  private readonly failureThreshold: number;
  private readonly failureWindowMs: number;
  private readonly recoveryMs: number;

  constructor(readonly name: string, opts: CircuitBreakerOptions = {}) {
    this.failureThreshold = opts.failureThreshold ?? 3;
    this.failureWindowMs  = opts.failureWindowMs  ?? 60_000;
    this.recoveryMs       = opts.recoveryMs        ?? 30_000;
  }

  getState(): CircuitState { this.maybeTransition(); return this.state; }

  isOpen(): boolean {
    this.maybeTransition();
    return this.state === 'OPEN';
  }

  isAvailable(): boolean {
    this.maybeTransition();
    return this.state !== 'OPEN';
  }

  /** Call after a successful request. Resets failure window; closes from HALF_OPEN. */
  recordSuccess(): void {
    this.failures = [];
    this.state = 'CLOSED';
  }

  /** Call after a failed request. May trip the breaker. */
  recordFailure(): void {
    this.maybeTransition();
    const now = Date.now();
    this.failures.push(now);
    // Evict failures outside the rolling window
    this.failures = this.failures.filter(t => now - t <= this.failureWindowMs);

    if (this.failures.length >= this.failureThreshold && this.state === 'CLOSED') {
      this.state = 'OPEN';
      this.openedAt = now;
    } else if (this.state === 'HALF_OPEN') {
      // Failed probe — re-open
      this.state = 'OPEN';
      this.openedAt = now;
    }
  }

  private maybeTransition(): void {
    if (this.state === 'OPEN' && Date.now() - this.openedAt >= this.recoveryMs) {
      this.state = 'HALF_OPEN';
    }
  }
}
