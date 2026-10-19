/** Rate-limit state as reported by Azure response headers. All fields optional: Azure omits some per endpoint/API version. */
export interface AzureRateLimitState {
  limitTokens?: number;
  remainingTokens?: number;
  resetTokensMs?: number;
  limitRequests?: number;
  remainingRequests?: number;
  retryAfterMs?: number;
}

export interface TokenBudget {
  readonly target: number;
  available(now: number): number;
  /** Checks and reserves in one synchronous step, so two callers can never both claim the same capacity. */
  tryReserve(tokens: number, now: number): boolean;
  /**
   * Tightens the local model when Azure reports less headroom than we believe we have.
   * `unacknowledged` is the reservation of requests already sent but not yet reflected in Azure's numbers.
   * Returns the tokens debited (0 when Azure agrees with or is more generous than the local view).
   */
  reconcile(state: AzureRateLimitState, now: number, unacknowledged: number): number;
  /** Admit nothing before `until` (e.g. Azure's Retry-After). */
  blockUntil(until: number): void;
  /** Earliest time `tokens` could be reserved, assuming no new reservations; Infinity if never. */
  nextAvailableAt(tokens: number, now: number): number;
}

interface Debit {
  tokens: number;
  expiresAt: number;
}

/**
 * Every reservation counts against the target for one full window after it is made, so the sum
 * admitted in any window-length interval never exceeds the target. This is stricter than a token
 * bucket (which allows a full burst plus refill within one window) and needs no calibration.
 *
 * Azure's headers only ever tighten this model, never loosen it: an over-estimate costs throughput,
 * an under-estimate costs a 429, and only the latter is visible to Codex.
 */
export class SlidingWindowBudget implements TokenBudget {
  readonly target: number;
  readonly windowMs: number;
  readonly azureLimit: number;
  #debits: Debit[] = []; // sorted by expiresAt
  #blockedUntil = 0;

  constructor(options: { target: number; windowMs: number; azureLimit: number }) {
    this.target = options.target;
    this.windowMs = options.windowMs;
    this.azureLimit = options.azureLimit;
  }

  used(now: number): number {
    this.#prune(now);
    let sum = 0;
    for (const debit of this.#debits) sum += debit.tokens;
    return sum;
  }

  available(now: number): number {
    if (now < this.#blockedUntil) return 0;
    return Math.max(0, this.target - this.used(now));
  }

  blockedUntil(): number {
    return this.#blockedUntil;
  }

  tryReserve(tokens: number, now: number): boolean {
    if (tokens > this.available(now)) return false;
    this.#debit(tokens, now + this.windowMs);
    return true;
  }

  reconcile(state: AzureRateLimitState, now: number, unacknowledged: number): number {
    if (state.remainingTokens === undefined) return 0;
    const margin = Math.max(0, (state.limitTokens ?? this.azureLimit) - this.target);
    const azureAvailable = state.remainingTokens - margin - unacknowledged;
    const localAvailable = Math.max(0, this.target - this.used(now));
    const deficit = Math.ceil(localAvailable - Math.max(0, azureAvailable));
    if (deficit <= 0) return 0;
    // Azure says when it will have capacity again; without a hint, assume a full window.
    const hint = state.resetTokensMs ?? state.retryAfterMs;
    const holdMs = hint !== undefined && hint > 0 ? Math.min(hint, this.windowMs) : this.windowMs;
    this.#debit(deficit, now + holdMs);
    return deficit;
  }

  blockUntil(until: number): void {
    this.#blockedUntil = Math.max(this.#blockedUntil, until);
  }

  nextAvailableAt(tokens: number, now: number): number {
    if (tokens > this.target) return Infinity;
    this.#prune(now);
    let at = Math.max(now, this.#blockedUntil);
    let used = 0;
    for (const debit of this.#debits) if (debit.expiresAt > at) used += debit.tokens;
    for (const debit of this.#debits) {
      if (debit.expiresAt <= at) continue;
      if (this.target - used >= tokens) return at;
      used -= debit.tokens;
      at = debit.expiresAt;
    }
    return at;
  }

  #debit(tokens: number, expiresAt: number): void {
    let i = this.#debits.length;
    while (i > 0 && this.#debits[i - 1]!.expiresAt > expiresAt) i--;
    this.#debits.splice(i, 0, { tokens, expiresAt });
  }

  #prune(now: number): void {
    let expired = 0;
    while (expired < this.#debits.length && this.#debits[expired]!.expiresAt <= now) expired++;
    if (expired > 0) this.#debits.splice(0, expired);
  }
}
