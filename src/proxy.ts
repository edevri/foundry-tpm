import { randomBytes } from "node:crypto";
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import { StringDecoder } from "node:string_decoder";
import type { AzureRateLimitState } from "./budget.ts";
import type { Config } from "./config.ts";
import { decodeBody, estimateRequest, type Estimate } from "./estimate.ts";
import { Governor, GovernorError, type Ticket } from "./governor.ts";
import { fmt, type Logger } from "./log.ts";
import type { Metrics } from "./metrics.ts";
import { classify429, isRetryable, parseRateLimitHeaders } from "./ratelimit.ts";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface ProxyDeps {
  config: Config;
  governor: Governor;
  metrics: Metrics;
  log: Logger;
}

export function createProxyServer(deps: ProxyDeps): http.Server {
  const { config, governor, metrics, log } = deps;
  const agents = {
    "http:": new http.Agent({ keepAlive: true }),
    "https:": new https.Agent({ keepAlive: true }),
  };
  let lastAzureState: AzureRateLimitState | undefined;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.url?.startsWith("/governor/")) return serveStatus(req, res);

    const id = randomBytes(3).toString("hex");
    metrics.requests_total++;
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) abort.abort();
    });

    let body: Buffer;
    try {
      body = await readBody(req, config.maxRequestBodyBytes);
    } catch (error) {
      return sendError(res, 413, "request_too_large", (error as Error).message);
    }

    const target = upstreamUrl(config, req.url ?? "/");
    const headers = forwardHeaders(req.headers, config);
    const governed = req.method === "POST" && body.length > 0;
    if (!governed) {
      log(`request ${id} ${req.method} ${target.pathname} forwarded without governing`);
      const ticketless = await sendUpstream(req.method ?? "GET", target, headers, body, abort.signal).catch(
        (error: Error) => error,
      );
      if (ticketless instanceof Error) return upstreamFailed(id, res, ticketless);
      return pipeResponse(id, res, ticketless, undefined, Date.now());
    }

    const estimate = estimateFor(id, req, body);
    metrics.estimated_tokens.observe(estimate.total);
    log(
      `request ${id} received: ${req.method} ${target.pathname}, estimated reservation ${fmt(estimate.total)} ` +
        `(input ${fmt(estimate.inputTokens)} + output ${fmt(estimate.outputTokens)} from ${estimate.outputSource})`,
    );

    const deadline = Date.now() + config.maxQueueWaitMs;
    for (let attempt = 0; ; attempt++) {
      let ticket: Ticket;
      try {
        ticket = await governor.acquire(id, estimate.total, { signal: abort.signal, deadline, front: attempt > 0 });
      } catch (error) {
        return governorFailed(res, error as GovernorError);
      }

      const startedAt = Date.now();
      let upstream: IncomingMessage;
      try {
        metrics.requests_forwarded++;
        upstream = await sendUpstream(req.method!, target, headers, body, abort.signal);
      } catch (error) {
        governor.release(ticket);
        return upstreamFailed(id, res, error as Error);
      }

      const state = parseRateLimitHeaders(upstream.headers);
      if (Object.keys(state).length > 0) lastAzureState = state;
      governor.acknowledge(ticket, state);
      log(`request ${id} Azure ${upstream.statusCode}: ${describeState(state)}, local available ${fmt(governor.budget.available(Date.now()))}`);

      if (upstream.statusCode !== 429) return pipeResponse(id, res, upstream, estimate, startedAt);

      metrics.azure_429_total++;
      const errorBody = await readBody(upstream, 1024 * 1024).catch(() => Buffer.alloc(0));
      const kind = classify429(state, errorBody.toString("utf8"));
      const waitMs = state.retryAfterMs ?? state.resetTokensMs ?? config.default429BackoffMs;
      log(
        `request ${id} UNEXPECTED Azure 429 (${kind}): local model admitted ${fmt(estimate.total)} tokens ` +
          `but Azure reports ${fmt(state.remainingTokens ?? NaN)} remaining; retry-after ${fmt(waitMs)}ms`,
      );
      if (!isRetryable(kind) || attempt >= config.maxInternal429Retries || Date.now() + waitMs > deadline) {
        log(`request ${id} passing 429 to client after ${attempt} internal retries`);
        res.writeHead(429, responseHeaders(upstream.headers));
        return void res.end(errorBody);
      }
      metrics.internal_retry_total++;
      governor.pauseUntil(Date.now() + waitMs);
    }
  }

  function estimateFor(id: string, req: IncomingMessage, body: Buffer): Estimate {
    const options = { charsPerToken: config.charsPerToken, defaultOutputReservation: config.defaultOutputReservation };
    try {
      const text = decodeBody(body, header(req.headers, "content-encoding")).toString("utf8");
      return estimateRequest(JSON.parse(text), options);
    } catch (error) {
      // Can't read it, so assume every byte is prompt.
      log(`request ${id}: could not parse body for estimation (${(error as Error).message}); using raw size`);
      return estimateRequest(body.toString("latin1"), options);
    }
  }

  function sendUpstream(
    method: string,
    target: URL,
    headers: http.OutgoingHttpHeaders,
    body: Buffer,
    signal: AbortSignal,
  ): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
      const client = target.protocol === "https:" ? https : http;
      const request = client.request(target, {
        method,
        headers: { ...headers, "content-length": body.length },
        agent: agents[target.protocol as "http:" | "https:"],
        signal,
      });
      request.on("response", resolve);
      request.on("error", reject);
      request.end(body);
    });
  }

  function pipeResponse(
    id: string,
    res: ServerResponse,
    upstream: IncomingMessage,
    estimate: Estimate | undefined,
    startedAt: number,
  ): void {
    res.writeHead(upstream.statusCode ?? 502, upstream.statusMessage, responseHeaders(upstream.headers));
    res.flushHeaders();
    const usage = estimate ? new UsageTap(header(upstream.headers, "content-type")) : undefined;
    upstream.on("data", (chunk: Buffer) => {
      usage?.write(chunk);
      // Honour backpressure from a slow client.
      if (!res.write(chunk)) {
        upstream.pause();
        res.once("drain", () => upstream.resume());
      }
    });
    let reported = false;
    const report = () => {
      if (reported || !estimate) return;
      reported = true;
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      const actual = usage?.result();
      if (!actual) {
        log(`request ${id} completed ${upstream.statusCode} in ${seconds}s (no usage reported)`);
        return;
      }
      metrics.actual_tokens.observe(actual.total);
      const ratio = actual.input > 0 ? (estimate.inputTokens / actual.input).toFixed(2) : "n/a";
      log(
        `request ${id} completed ${upstream.statusCode} in ${seconds}s: actual input ${fmt(actual.input)} ` +
          `(estimated ${fmt(estimate.inputTokens)}, ratio ${ratio}), output ${fmt(actual.output)} ` +
          `(reserved ${fmt(estimate.outputTokens)})`,
      );
    };
    upstream.on("end", () => {
      res.end();
      report();
    });
    upstream.on("error", (error) => {
      log(`request ${id} upstream stream error: ${error.message}`);
      res.destroy(error);
    });
    res.on("close", () => {
      if (upstream.complete) return;
      upstream.destroy();
      // Codex hangs up as soon as it has the final event, before Azure closes the stream.
      if (usage?.result()) report();
      else log(`request ${id} client disconnected mid-stream; aborting upstream`);
    });
  }

  function upstreamFailed(id: string, res: ServerResponse, error: Error): void {
    if (error.name === "AbortError") {
      log(`request ${id} client disconnected before Azure responded`);
      return;
    }
    metrics.upstream_errors++;
    log(`request ${id} upstream failure: ${error.message}`);
    sendError(res, 502, "upstream_unavailable", `governor could not reach Azure: ${error.message}`);
  }

  function governorFailed(res: ServerResponse, error: GovernorError): void {
    switch (error.kind) {
      case "too_large":
        return sendError(res, 413, "reservation_too_large", error.message);
      case "queue_full":
      case "timeout":
        return sendError(res, 503, `governor_${error.kind}`, error.message);
      case "aborted":
        return;
    }
  }

  function serveStatus(req: IncomingMessage, res: ServerResponse): void {
    const now = Date.now();
    const payload = {
      tpm_target: governor.budget.target,
      azure_tpm_limit: config.azureTpmLimit,
      available_tokens: governor.budget.available(now),
      queue_depth: governor.queueDepth,
      last_azure_state: lastAzureState ?? null,
      metrics,
    };
    if (req.url === "/governor/health") return sendJson(res, 200, { ok: true });
    if (req.url === "/governor/status") return sendJson(res, 200, payload);
    sendJson(res, 404, { error: { message: "unknown governor endpoint" } });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error: Error) => {
      log(`internal error: ${error.stack ?? error.message}`);
      if (!res.headersSent) sendError(res, 500, "governor_internal_error", error.message);
      else res.destroy();
    });
  });
  // Codex streams can sit idle while the model thinks; never time them out locally.
  server.requestTimeout = 0;
  server.on("close", () => {
    agents["http:"].destroy();
    agents["https:"].destroy();
  });
  return server;
}

function upstreamUrl(config: Config, requestUrl: string): URL {
  const incoming = new URL(requestUrl, "http://placeholder");
  const target = new URL(config.upstream.href);
  target.pathname = target.pathname.replace(/\/+$/, "") + incoming.pathname;
  target.search = incoming.search;
  if (config.apiVersion && !target.searchParams.has("api-version") && !/\/v1(\/|$)/.test(target.pathname)) {
    target.searchParams.set("api-version", config.apiVersion);
  }
  return target;
}

function forwardHeaders(incoming: IncomingHttpHeaders, config: Config): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (HOP_BY_HOP.has(name) || name === "host" || name === "content-length") continue;
    // Keep upstream responses uncompressed so usage can be read from the stream.
    if (name === "accept-encoding") continue;
    headers[name] = value;
  }
  if (config.apiKey && !incoming.authorization && !incoming["api-key"]) {
    headers["api-key"] = config.apiKey;
  }
  return headers;
}

function responseHeaders(incoming: IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (!HOP_BY_HOP.has(name)) headers[name] = value;
  }
  return headers;
}

function describeState(state: AzureRateLimitState): string {
  if (state.remainingTokens === undefined) return "no token rate-limit headers";
  const parts = [`limit ${fmt(state.limitTokens ?? NaN)}`, `remaining ${fmt(state.remainingTokens)}`];
  if (state.resetTokensMs !== undefined) parts.push(`reset ${fmt(state.resetTokensMs)}ms`);
  return parts.join(", ");
}

function readBody(stream: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    stream.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error(`body exceeds ${limit} bytes`));
        stream.destroy();
        return;
      }
      chunks.push(chunk);
    });
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
    stream.on("close", () => reject(new Error("stream closed before end")));
  });
}

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  if (res.headersSent || res.destroyed) return;
  sendJson(res, status, { error: { message, type: "governor_error", code } });
}

const MAX_JSON_USAGE_BYTES = 16 * 1024 * 1024;

interface Usage {
  input: number;
  output: number;
  total: number;
}

/** Picks the final `usage` object out of a Responses/Chat Completions SSE stream or JSON body. */
class UsageTap {
  readonly #sse: boolean;
  readonly #decoder = new StringDecoder("utf8");
  #pending = "";
  #usage: Usage | undefined;

  constructor(contentType: string | undefined) {
    this.#sse = contentType?.includes("text/event-stream") ?? false;
  }

  write(chunk: Buffer): void {
    if (!this.#sse && this.#pending.length > MAX_JSON_USAGE_BYTES) return;
    this.#pending += this.#decoder.write(chunk);
    if (!this.#sse) return;
    let newline: number;
    while ((newline = this.#pending.indexOf("\n")) !== -1) {
      const line = this.#pending.slice(0, newline);
      this.#pending = this.#pending.slice(newline + 1);
      if (line.startsWith("data:") && line.includes('"usage"')) this.#take(line.slice(5));
    }
  }

  result(): Usage | undefined {
    this.#pending += this.#decoder.end();
    if (!this.#sse) this.#take(this.#pending);
    return this.#usage;
  }

  #take(json: string): void {
    let parsed: { usage?: unknown; response?: { usage?: unknown } };
    try {
      parsed = JSON.parse(json);
    } catch {
      return;
    }
    const usage = (parsed.response?.usage ?? parsed.usage) as Record<string, number> | null | undefined;
    if (!usage || typeof usage !== "object") return;
    const input = usage.input_tokens ?? usage.prompt_tokens ?? 0;
    const output = usage.output_tokens ?? usage.completion_tokens ?? 0;
    this.#usage = { input, output, total: usage.total_tokens ?? input + output };
  }
}
