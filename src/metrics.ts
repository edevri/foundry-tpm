export class Summary {
  count = 0;
  sum = 0;
  max = 0;

  observe(value: number): void {
    this.count++;
    this.sum += value;
    if (value > this.max) this.max = value;
  }

  toJSON() {
    return { count: this.count, sum: this.sum, max: this.max, avg: this.count ? Math.round(this.sum / this.count) : 0 };
  }
}

export class Metrics {
  requests_total = 0;
  requests_forwarded = 0;
  requests_queued = 0;
  requests_rejected_too_large = 0;
  requests_rejected_queue_full = 0;
  requests_queue_timeout = 0;
  requests_client_aborted = 0;
  upstream_errors = 0;
  azure_429_total = 0;
  internal_retry_total = 0;
  reconcile_debit_tokens = 0;
  queue_wait_ms = new Summary();
  estimated_tokens = new Summary();
  actual_tokens = new Summary();
}
