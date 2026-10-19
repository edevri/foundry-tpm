import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { close, post, responsesBody, sleep, sseOk, startFakeUpstream, startGovernor, waitFor } from "./helpers.ts";

const servers: Array<import("node:http").Server> = [];
after(() => close(...servers));

async function setup(handler: Parameters<typeof startFakeUpstream>[0], env: Record<string, string> = {}) {
  const upstream = await startFakeUpstream(handler);
  const governor = await startGovernor(upstream.url, env);
  servers.push(upstream.server, governor.server);
  return { upstream, governor };
}

describe("governor proxy", () => {
  it("queues the request that would exceed the TPM target instead of sending it (A, B forwarded; C waits)", async () => {
    const window = 800;
    const { upstream, governor } = await setup((_req, res) => sseOk(res), {
      AZURE_TPM_LIMIT: "250000",
      GOVERNOR_TPM_TARGET: "250000",
      GOVERNOR_WINDOW_MS: String(window),
    });

    const a = post(governor.url, responsesBody(100_000));
    const b = post(governor.url, responsesBody(100_000));
    await waitFor(() => upstream.requests.length === 2);
    const c = post(governor.url, responsesBody(100_000));

    await sleep(window / 2);
    assert.equal(upstream.requests.length, 2, "C must not reach Azure while capacity is exhausted");
    assert.equal(governor.governor.queueDepth, 1);

    const [ra, rb, rc] = await Promise.all([a, b, c]);
    assert.deepEqual([ra.status, rb.status, rc.status], [200, 200, 200]);
    assert.equal(upstream.requests.length, 3);
    const [first, , third] = upstream.requests;
    assert.ok(third!.at - first!.at >= window - 5, "C forwarded only after A's reservation left the window");
    assert.equal(governor.metrics.azure_429_total, 0);
    assert.ok(governor.logs.some((l) => /request \w+ queued/.test(l)));
    assert.ok(governor.logs.some((l) => /admitted after/.test(l)));
  });

  it("keeps many concurrent requests within the target in every window", async () => {
    const window = 400;
    const target = 100_000;
    const { upstream, governor } = await setup((_req, res) => sseOk(res), {
      GOVERNOR_TPM_TARGET: String(target),
      AZURE_TPM_LIMIT: String(target),
      GOVERNOR_WINDOW_MS: String(window),
      MAX_QUEUE_WAIT_MS: "30000",
    });

    const responses = await Promise.all(
      Array.from({ length: 40 }, (_, i) => post(governor.url, responsesBody(10_000 + (i % 4) * 5_000))),
    );
    assert.ok(responses.every((r) => r.status === 200));
    await Promise.all(responses.map((r) => r.text()));

    const sent = upstream.requests.map((r) => ({ at: r.at, tokens: r.body.max_output_tokens as number }));
    // Arrival at the fake lags admission by a few ms, so measure over a slightly narrower window.
    for (const { at } of sent) {
      const sum = sent.filter((s) => s.at >= at && s.at < at + window - 20).reduce((n, s) => n + s.tokens, 0);
      assert.ok(sum <= target, `window starting ${at} carried ${sum} > ${target}`);
    }
  });

  it("streams chunks through as they arrive", async () => {
    const { governor } = await setup(async (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n");
      await sleep(300);
      res.end("data: second\n\n");
    });
    const started = Date.now();
    const response = await post(governor.url, responsesBody(10));
    const reader = response.body!.getReader();
    const first = await reader.read();
    assert.match(new TextDecoder().decode(first.value), /first/);
    assert.ok(Date.now() - started < 250, "first chunk must not wait for the whole response");
    let rest = "";
    for (let r = await reader.read(); !r.done; r = await reader.read()) rest += new TextDecoder().decode(r.value);
    assert.match(rest, /second/);
  });

  it("rejects a request larger than the target immediately without contacting Azure", async () => {
    const { upstream, governor } = await setup((_req, res) => sseOk(res), { GOVERNOR_TPM_TARGET: "1000", AZURE_TPM_LIMIT: "1000" });
    const response = await post(governor.url, responsesBody(5_000));
    assert.equal(response.status, 413);
    const body = await response.json();
    assert.match(body.error.message, /estimated token reservation exceeds configured TPM capacity/);
    assert.equal(upstream.requests.length, 0);
  });

  it("absorbs a TPM 429 from Azure and retries after Retry-After", async () => {
    let calls = 0;
    const { upstream, governor } = await setup((_req, res) => {
      if (calls++ === 0) {
        res.writeHead(429, { "retry-after-ms": "150", "x-ratelimit-remaining-tokens": "0", "content-type": "application/json" });
        res.end('{"error":{"code":"429","message":"exceeded token rate limit"}}');
        return;
      }
      sseOk(res);
    });
    const response = await post(governor.url, responsesBody(10));
    assert.equal(response.status, 200);
    assert.equal(upstream.requests.length, 2);
    assert.ok(upstream.requests[1]!.at - upstream.requests[0]!.at >= 140);
    assert.equal(governor.metrics.azure_429_total, 1);
    assert.equal(governor.metrics.internal_retry_total, 1);
    assert.ok(governor.logs.some((l) => /UNEXPECTED Azure 429 \(tokens\)/.test(l)));
  });

  it("passes the 429 through once retries are exhausted, and never retries quota errors", async () => {
    const { upstream, governor } = await setup((req, res) => {
      res.writeHead(429, { "retry-after-ms": "10", "content-type": "application/json" });
      res.end(req.body.input === "quota" ? '{"error":{"code":"insufficient_quota"}}' : '{"error":{"message":"token rate limit"}}');
    }, { MAX_INTERNAL_429_RETRIES: "2" });

    const limited = await post(governor.url, responsesBody(10));
    assert.equal(limited.status, 429);
    assert.equal(upstream.requests.length, 3);

    const quota = await post(governor.url, responsesBody(10, { input: "quota" }));
    assert.equal(quota.status, 429);
    assert.equal(upstream.requests.length, 4);
  });

  it("tightens the budget from Azure's remaining-tokens header", async () => {
    const { upstream, governor } = await setup((_req, res) => sseOk(res, { "x-ratelimit-remaining-tokens": "1000", "x-ratelimit-limit-tokens": "100000" }), {
      GOVERNOR_TPM_TARGET: "100000",
      AZURE_TPM_LIMIT: "100000",
      GOVERNOR_WINDOW_MS: "300",
    });
    await (await post(governor.url, responsesBody(10))).text();
    // Locally ~99,990 should be free, but Azure says 1,000: a 5,000-token request must wait.
    const pending = post(governor.url, responsesBody(5_000));
    await sleep(100);
    assert.equal(upstream.requests.length, 1);
    assert.equal((await pending).status, 200);
    assert.ok(governor.metrics.reconcile_debit_tokens > 0);
  });

  it("drops a queued request when its client disconnects", async () => {
    const { upstream, governor } = await setup((_req, res) => sseOk(res), {
      GOVERNOR_TPM_TARGET: "1000",
      AZURE_TPM_LIMIT: "1000",
      GOVERNOR_WINDOW_MS: "500",
    });
    await (await post(governor.url, responsesBody(900))).text();
    const controller = new AbortController();
    const abandoned = post(governor.url, responsesBody(900), { signal: controller.signal }).catch(() => "aborted");
    await waitFor(() => governor.governor.queueDepth === 1);
    controller.abort();
    assert.equal(await abandoned, "aborted");
    await waitFor(() => governor.governor.queueDepth === 0);
    await sleep(600);
    assert.equal(upstream.requests.length, 1, "abandoned request must never be sent");
    assert.equal(governor.metrics.requests_client_aborted, 1);
  });

  it("aborts the upstream stream when the client disconnects mid-stream", async () => {
    let upstreamClosed = false;
    const { governor } = await setup((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n");
      res.on("close", () => (upstreamClosed = true));
    });
    const controller = new AbortController();
    const response = await post(governor.url, responsesBody(10), { signal: controller.signal });
    await response.body!.getReader().read();
    controller.abort();
    await waitFor(() => upstreamClosed);
  });

  it("logs a completion when the client hangs up right after the final event (as Codex does)", async () => {
    let upstreamClosed = false;
    const { governor } = await setup((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":5}}}\n\n`);
      res.on("close", () => (upstreamClosed = true));
    });
    const controller = new AbortController();
    const response = await post(governor.url, responsesBody(10), { signal: controller.signal });
    await response.body!.getReader().read();
    controller.abort();
    await waitFor(() => upstreamClosed);
    await waitFor(() => governor.logs.some((l) => /completed 200 .*actual input 10/.test(l)));
    assert.ok(!governor.logs.some((l) => /disconnected/.test(l)));
  });

  it("answers 503 when the queue is full or the wait exceeds the limit", async () => {
    const { governor } = await setup((_req, res) => sseOk(res), {
      GOVERNOR_TPM_TARGET: "1000",
      AZURE_TPM_LIMIT: "1000",
      GOVERNOR_WINDOW_MS: "60000",
      MAX_QUEUE_DEPTH: "1",
      MAX_QUEUE_WAIT_MS: "200",
    });
    await (await post(governor.url, responsesBody(900))).text();
    const waiting = post(governor.url, responsesBody(900));
    await waitFor(() => governor.governor.queueDepth === 1);
    const full = await post(governor.url, responsesBody(900));
    assert.equal(full.status, 503);
    assert.equal((await full.json()).error.code, "governor_queue_full");
    const timedOut = await waiting;
    assert.equal(timedOut.status, 503);
    assert.equal((await timedOut.json()).error.code, "governor_timeout");
  });

  it("forwards path, query and client credentials unchanged, and never logs secrets", async () => {
    const { upstream, governor } = await setup((_req, res) => sseOk(res), { AZURE_OPENAI_API_KEY: "proxy-secret-key" });
    await (await fetch(`${governor.url}/openai/responses?api-version=2025-04-01-preview`, {
      method: "POST",
      headers: { "content-type": "application/json", "api-key": "client-secret-key" },
      body: JSON.stringify(responsesBody(10)),
    })).text();
    await (await fetch(`${governor.url}/openai/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(responsesBody(10)),
    })).text();

    const [withClientKey, withProxyKey] = upstream.requests;
    assert.equal(withClientKey!.url, "/openai/responses?api-version=2025-04-01-preview");
    assert.equal(withClientKey!.headers["api-key"], "client-secret-key");
    assert.equal(withProxyKey!.headers["api-key"], "proxy-secret-key");
    const logs = governor.logs.join("\n");
    assert.doesNotMatch(logs, /secret-key/);
    assert.match(logs, /actual input 10/);
  });
});
