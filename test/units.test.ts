import assert from "node:assert/strict";
import { describe, it } from "node:test";
import zlib from "node:zlib";
import { SlidingWindowBudget } from "../src/budget.ts";
import { decodeBody, estimateRequest } from "../src/estimate.ts";
import { classify429, durationMs, parseRateLimitHeaders } from "../src/ratelimit.ts";

const budget = () => new SlidingWindowBudget({ target: 250_000, windowMs: 60_000, azureLimit: 250_000 });

describe("SlidingWindowBudget", () => {
  it("admits until the target and frees capacity a full window after each reservation", () => {
    const b = budget();
    assert.equal(b.tryReserve(100_000, 0), true);
    assert.equal(b.tryReserve(100_000, 1_000), true);
    assert.equal(b.tryReserve(100_000, 2_000), false);
    assert.equal(b.available(2_000), 50_000);
    assert.equal(b.nextAvailableAt(100_000, 2_000), 60_000);
    assert.equal(b.available(59_999), 50_000);
    assert.equal(b.tryReserve(100_000, 60_000), true);
  });

  it("never admits more than the target within any window", () => {
    const b = budget();
    const admitted: Array<[number, number]> = [];
    for (let t = 0; t < 300_000; t += 997) {
      const tokens = 10_000 + ((t * 7919) % 90_000);
      if (b.tryReserve(tokens, t)) admitted.push([t, tokens]);
    }
    for (const [start] of admitted) {
      const inWindow = admitted.filter(([t]) => t >= start && t < start + 60_000).reduce((s, [, n]) => s + n, 0);
      assert.ok(inWindow <= 250_000, `window at ${start} admitted ${inWindow}`);
    }
  });

  it("reports Infinity for requests that can never fit", () => {
    assert.equal(budget().nextAvailableAt(250_001, 0), Infinity);
  });

  it("blocks admission until a Retry-After deadline", () => {
    const b = budget();
    b.blockUntil(5_000);
    assert.equal(b.tryReserve(1, 4_999), false);
    assert.equal(b.nextAvailableAt(1, 0), 5_000);
    assert.equal(b.tryReserve(1, 5_000), true);
  });

  it("tightens to Azure's remaining tokens, keeping the safety margin", () => {
    const b = new SlidingWindowBudget({ target: 225_000, windowMs: 60_000, azureLimit: 250_000 });
    b.tryReserve(50_000, 0);
    // Azure says 100k left; minus the 25k margin we may use 75k, not the 175k we thought.
    const debit = b.reconcile({ limitTokens: 250_000, remainingTokens: 100_000 }, 0, 0);
    assert.equal(debit, 100_000);
    assert.equal(b.available(0), 75_000);
    // Requests admitted after this response are not in Azure's figure yet.
    const b2 = new SlidingWindowBudget({ target: 225_000, windowMs: 60_000, azureLimit: 250_000 });
    b2.tryReserve(50_000, 0);
    b2.tryReserve(40_000, 0);
    assert.equal(b2.reconcile({ limitTokens: 250_000, remainingTokens: 200_000 }, 0, 40_000), 0);
  });

  it("never loosens from Azure's headers", () => {
    const b = budget();
    b.tryReserve(200_000, 0);
    assert.equal(b.reconcile({ remainingTokens: 250_000 }, 0, 0), 0);
    assert.equal(b.available(0), 50_000);
  });

  it("holds a reconciliation debit only until Retry-After when no reset is given", () => {
    const b = budget();
    b.reconcile({ remainingTokens: 0, retryAfterMs: 150 }, 0, 0);
    assert.equal(b.available(149), 0);
    assert.equal(b.available(150), 250_000);
  });

  it("releases a reconciliation debit at Azure's reset time", () => {
    const b = budget();
    b.reconcile({ remainingTokens: 0, resetTokensMs: 6_000 }, 0, 0);
    assert.equal(b.available(5_999), 0);
    assert.equal(b.available(6_000), 250_000);
  });
});

describe("estimateRequest", () => {
  const options = { charsPerToken: 4, defaultOutputReservation: 1_000 };

  it("reserves the declared output limit, falling back to the default", () => {
    assert.equal(estimateRequest({ input: "", max_output_tokens: 5_000 }, options).outputTokens, 5_000);
    assert.equal(estimateRequest({ messages: [], max_completion_tokens: 7 }, options).outputTokens, 7);
    assert.equal(estimateRequest({ messages: [], max_tokens: 9, n: 3 }, options).outputTokens, 27);
    assert.equal(estimateRequest({ input: "" }, options).outputSource, "default");
  });

  it("counts prompt text by characters", () => {
    const small = estimateRequest({ input: "x".repeat(400) }, options).inputTokens;
    const big = estimateRequest({ input: "x".repeat(40_000) }, options).inputTokens;
    assert.ok(big - small >= 9_900 && big - small <= 10_000);
  });

  it("does not count inline images or encrypted reasoning as raw text", () => {
    const image = estimateRequest({ input: [{ image_url: `data:image/png;base64,${"A".repeat(1_000_000)}` }] }, options);
    assert.ok(image.inputTokens < 2_000);
    const reasoning = estimateRequest({ input: [{ encrypted_content: "A".repeat(16_000) }] }, options);
    assert.ok(reasoning.inputTokens >= 3_000 && reasoning.inputTokens < 3_100);
  });

  it("decodes compressed request bodies", () => {
    const raw = Buffer.from('{"input":"hello"}');
    assert.deepEqual(decodeBody(zlib.gzipSync(raw), "gzip"), raw);
    assert.deepEqual(decodeBody(zlib.zstdCompressSync(raw), "zstd"), raw);
    assert.deepEqual(decodeBody(raw, undefined), raw);
  });
});

describe("rate-limit headers", () => {
  it("parses Azure/OpenAI headers", () => {
    const state = parseRateLimitHeaders({
      "x-ratelimit-limit-tokens": "250000",
      "x-ratelimit-remaining-tokens": "1234",
      "x-ratelimit-reset-tokens": "1m6s",
      "retry-after-ms": "250",
      "retry-after": "1",
    });
    assert.deepEqual(state, { limitTokens: 250_000, remainingTokens: 1_234, resetTokensMs: 66_000, retryAfterMs: 250 });
    assert.equal(parseRateLimitHeaders({ "retry-after": "2" }).retryAfterMs, 2_000);
  });

  it("parses durations", () => {
    assert.equal(durationMs("6"), 6_000);
    assert.equal(durationMs("0.5s"), 500);
    assert.equal(durationMs("120ms"), 120);
    assert.equal(durationMs("bogus"), undefined);
  });

  it("tells TPM 429s from RPM and quota 429s", () => {
    const tpm = "Requests to the Responses Operation have exceeded token rate limit of your current tier.";
    assert.equal(classify429({}, tpm), "tokens");
    assert.equal(classify429({}, "exceeded call rate limit"), "requests");
    assert.equal(classify429({}, '{"error":{"code":"insufficient_quota"}}'), "quota");
    assert.equal(classify429({ remainingTokens: 0 }, ""), "tokens");
  });
});
