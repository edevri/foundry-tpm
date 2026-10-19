import type { IncomingHttpHeaders } from "node:http";
import type { AzureRateLimitState } from "./budget.ts";

export function parseRateLimitHeaders(headers: IncomingHttpHeaders, now = Date.now()): AzureRateLimitState {
  const state: AzureRateLimitState = {};
  const limitTokens = intHeader(headers, "x-ratelimit-limit-tokens");
  const remainingTokens = intHeader(headers, "x-ratelimit-remaining-tokens");
  const resetTokensMs = durationMs(header(headers, "x-ratelimit-reset-tokens"));
  const limitRequests = intHeader(headers, "x-ratelimit-limit-requests");
  const remainingRequests = intHeader(headers, "x-ratelimit-remaining-requests");
  const retryAfterMs = retryAfter(headers, now);
  if (limitTokens !== undefined) state.limitTokens = limitTokens;
  if (remainingTokens !== undefined) state.remainingTokens = remainingTokens;
  if (resetTokensMs !== undefined) state.resetTokensMs = resetTokensMs;
  if (limitRequests !== undefined) state.limitRequests = limitRequests;
  if (remainingRequests !== undefined) state.remainingRequests = remainingRequests;
  if (retryAfterMs !== undefined) state.retryAfterMs = retryAfterMs;
  return state;
}

export type RateLimitKind = "tokens" | "requests" | "quota" | "unknown";

/** Azure uses 429 for TPM, RPM and exhausted quota alike; only the first two clear up by waiting. */
export function classify429(state: AzureRateLimitState, body: string): RateLimitKind {
  const text = body.toLowerCase();
  if (/token rate limit|tokens per min|\btpm\b/.test(text)) return "tokens";
  if (/call rate limit|request rate limit|requests per min|\brpm\b/.test(text)) return "requests";
  if (/quota|billing|insufficient/.test(text)) return "quota";
  if (state.remainingTokens === 0) return "tokens";
  if (state.remainingRequests === 0) return "requests";
  return "unknown";
}

export function isRetryable(kind: RateLimitKind): boolean {
  return kind !== "quota";
}

function retryAfter(headers: IncomingHttpHeaders, now: number): number | undefined {
  const ms = Number(header(headers, "retry-after-ms"));
  if (header(headers, "retry-after-ms") && Number.isFinite(ms) && ms >= 0) return ms;
  const raw = header(headers, "retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** Accepts plain seconds ("6", "0.5") and OpenAI-style durations ("1m30s", "250ms"). */
export function durationMs(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  const seconds = Number(trimmed);
  if (trimmed !== "" && Number.isFinite(seconds)) return seconds * 1000;
  const units: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1_000, ms: 1 };
  let total = 0;
  let matched = "";
  for (const match of trimmed.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    total += Number(match[1]) * units[match[2]!]!;
    matched += match[0];
  }
  return matched === trimmed && matched !== "" ? total : undefined;
}

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function intHeader(headers: IncomingHttpHeaders, name: string): number | undefined {
  const raw = header(headers, name);
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}
