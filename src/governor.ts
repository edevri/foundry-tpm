import type { AzureRateLimitState, TokenBudget } from "./budget.ts";
import { fmt, type Logger } from "./log.ts";
import type { Metrics } from "./metrics.ts";

export type GovernorErrorKind = "too_large" | "queue_full" | "timeout" | "aborted";

export class GovernorError extends Error {
  readonly kind: GovernorErrorKind;

  constructor(kind: GovernorErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

/** Capacity granted to one upstream attempt. */
export interface Ticket {
  readonly id: string;
  readonly tokens: number;
  readonly seq: number;
}

export interface AcquireOptions {
  signal?: AbortSignal;
  /** Absolute time after which a queued request gives up. */
  deadline?: number;
  /** Retries go to the front: they already waited their turn once. */
  front?: boolean;
}

interface Waiter {
  id: string;
  tokens: number;
  enqueuedAt: number;
  resolve: (ticket: Ticket) => void;
  reject: (error: GovernorError) => void;
  cleanup: () => void;
}

export interface GovernorOptions {
  budget: TokenBudget;
  maxQueueDepth: number;
  maxQueueWaitMs: number;
  metrics: Metrics;
  log: Logger;
  now?: () => number;
}

/** One global FIFO queue in front of one global budget, shared by every connection. */
export class Governor {
  readonly budget: TokenBudget;
  readonly #options: GovernorOptions;
  readonly #now: () => number;
  readonly #queue: Waiter[] = [];
  /** Admitted attempts whose Azure response headers have not arrived yet. */
  readonly #unacknowledged = new Map<number, Ticket>();
  #seq = 0;
  #timer: NodeJS.Timeout | undefined;

  constructor(options: GovernorOptions) {
    this.budget = options.budget;
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  get queueDepth(): number {
    return this.#queue.length;
  }

  acquire(id: string, tokens: number, options: AcquireOptions = {}): Promise<Ticket> {
    const { log, metrics, maxQueueDepth, maxQueueWaitMs } = this.#options;
    const now = this.#now();
    const budget = this.budget;

    if (tokens > budget.target) {
      metrics.requests_rejected_too_large++;
      log(`request ${id} rejected: estimated reservation ${fmt(tokens)} exceeds TPM target ${fmt(budget.target)}`);
      return Promise.reject(new GovernorError(
        "too_large",
        `estimated token reservation exceeds configured TPM capacity (${fmt(tokens)} > ${fmt(budget.target)})`,
      ));
    }
    if (options.signal?.aborted) {
      return Promise.reject(new GovernorError("aborted", "client disconnected"));
    }

    const available = budget.available(now);
    const mayJumpQueue = options.front || this.#queue.length === 0;
    if (mayJumpQueue && budget.tryReserve(tokens, now)) {
      log(`request ${id} admitted (reservation ${fmt(tokens)}, available ${fmt(available)} → ${fmt(budget.available(now))})`);
      return Promise.resolve(this.#issue(id, tokens));
    }

    if (!options.front && this.#queue.length >= maxQueueDepth) {
      metrics.requests_rejected_queue_full++;
      log(`request ${id} rejected: queue full (${this.#queue.length})`);
      return Promise.reject(new GovernorError("queue_full", `governor queue is full (${maxQueueDepth} waiting)`));
    }

    return new Promise<Ticket>((resolve, reject) => {
      const deadline = options.deadline ?? now + maxQueueWaitMs;
      const waiter: Waiter = {
        id,
        tokens,
        enqueuedAt: now,
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timeout);
          options.signal?.removeEventListener("abort", onAbort);
        },
      };
      const drop = (error: GovernorError) => {
        const index = this.#queue.indexOf(waiter);
        if (index === -1) return;
        this.#queue.splice(index, 1);
        waiter.cleanup();
        reject(error);
        // A smaller request may now be at the head.
        if (index === 0) this.#pump();
      };
      const onAbort = () => {
        metrics.requests_client_aborted++;
        log(`request ${id} abandoned by client while queued (${fmt(this.#now() - now)}ms)`);
        drop(new GovernorError("aborted", "client disconnected"));
      };
      const timeout = setTimeout(() => {
        metrics.requests_queue_timeout++;
        log(`request ${id} timed out in queue after ${fmt(this.#now() - now)}ms`);
        drop(new GovernorError("timeout", `request waited longer than ${maxQueueWaitMs}ms for TPM capacity`));
      }, Math.max(0, deadline - now));
      options.signal?.addEventListener("abort", onAbort, { once: true });

      if (options.front) this.#queue.unshift(waiter);
      else this.#queue.push(waiter);
      metrics.requests_queued++;
      log(`request ${id} queued (reservation ${fmt(tokens)}, available ${fmt(available)}, queue depth ${this.#queue.length})`);
      this.#pump();
    });
  }

  /** Azure answered (any status): fold its rate-limit headers into the budget. */
  acknowledge(ticket: Ticket, state: AzureRateLimitState): void {
    this.#unacknowledged.delete(ticket.seq);
    let later = 0;
    for (const other of this.#unacknowledged.values()) {
      if (other.seq > ticket.seq) later += other.tokens;
    }
    const now = this.#now();
    const before = this.budget.available(now);
    const debit = this.budget.reconcile(state, now, later);
    if (debit > 0) {
      this.#options.metrics.reconcile_debit_tokens += debit;
      this.#options.log(
        `request ${ticket.id}: Azure reports ${fmt(state.remainingTokens ?? 0)} remaining; ` +
          `local model was optimistic, available ${fmt(before)} → ${fmt(this.budget.available(now))}`,
      );
    }
    // Reconciliation only ever removes capacity, but keep the wakeup accurate.
    this.#pump();
  }

  /** The attempt ended without Azure headers (connection error, client abort). */
  release(ticket: Ticket): void {
    this.#unacknowledged.delete(ticket.seq);
  }

  /** Pause all admissions, e.g. for Azure's Retry-After. */
  pauseUntil(until: number): void {
    this.budget.blockUntil(until);
    this.#pump();
  }

  #issue(id: string, tokens: number): Ticket {
    const ticket: Ticket = { id, tokens, seq: ++this.#seq };
    this.#unacknowledged.set(ticket.seq, ticket);
    return ticket;
  }

  #pump(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    const { log, metrics } = this.#options;
    const now = this.#now();
    while (this.#queue.length > 0) {
      const head = this.#queue[0]!;
      const available = this.budget.available(now);
      if (!this.budget.tryReserve(head.tokens, now)) break;
      this.#queue.shift();
      head.cleanup();
      const waited = now - head.enqueuedAt;
      metrics.queue_wait_ms.observe(waited);
      log(
        `request ${head.id} admitted after ${(waited / 1000).toFixed(1)}s ` +
          `(reservation ${fmt(head.tokens)}, available ${fmt(available)} → ${fmt(this.budget.available(now))})`,
      );
      head.resolve(this.#issue(head.id, head.tokens));
    }
    const head = this.#queue[0];
    if (head) {
      const at = this.budget.nextAvailableAt(head.tokens, now);
      this.#timer = setTimeout(() => this.#pump(), Math.max(1, at - now));
      this.#timer.unref();
    }
  }
}
