import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { SlidingWindowBudget } from "../src/budget.ts";
import { loadConfig, type Config } from "../src/config.ts";
import { Governor } from "../src/governor.ts";
import { Metrics } from "../src/metrics.ts";
import { createProxyServer } from "../src/proxy.ts";

export interface UpstreamRequest {
  at: number;
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}

export type UpstreamHandler = (req: UpstreamRequest, res: ServerResponse, raw: IncomingMessage) => void | Promise<void>;

/** Fake Azure: records every request it sees and delegates the response to the test. */
export async function startFakeUpstream(handler: UpstreamHandler) {
  const requests: UpstreamRequest[] = [];
  const server = http.createServer(async (raw, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of raw) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    const req: UpstreamRequest = {
      at: Date.now(),
      method: raw.method ?? "",
      url: raw.url ?? "",
      headers: raw.headers,
      body: text ? JSON.parse(text) : undefined,
    };
    // Local port scanners probe new listeners with `GET /`; only count API traffic.
    if (req.url.startsWith("/openai")) requests.push(req);
    await handler(req, res, raw);
  });
  await listen(server);
  return { server, requests, url: `http://127.0.0.1:${port(server)}` };
}

export async function startGovernor(upstreamUrl: string, env: Record<string, string> = {}) {
  const config: Config = loadConfig({
    AZURE_OPENAI_ENDPOINT: upstreamUrl,
    PORT: "0",
    DEFAULT_OUTPUT_RESERVATION: "0",
    ...env,
  });
  const logs: string[] = [];
  const log = (message: string) => logs.push(message);
  const metrics = new Metrics();
  const budget = new SlidingWindowBudget({
    target: config.tpmTarget,
    windowMs: config.windowMs,
    azureLimit: config.azureTpmLimit,
  });
  const governor = new Governor({
    budget,
    maxQueueDepth: config.maxQueueDepth,
    maxQueueWaitMs: config.maxQueueWaitMs,
    metrics,
    log,
  });
  const server = createProxyServer({ config, governor, metrics, log });
  await listen(server);
  return { server, governor, metrics, logs, url: `http://127.0.0.1:${port(server)}` };
}

/** A Responses API body whose reservation is ~`tokens` (dominated by max_output_tokens). */
export function responsesBody(tokens: number, extra: Record<string, unknown> = {}) {
  return { model: "sol", input: "hi", stream: true, max_output_tokens: tokens, ...extra };
}

export function post(url: string, body: unknown, init: RequestInit = {}) {
  return fetch(`${url}/openai/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer client-secret-key" },
    body: JSON.stringify(body),
    ...init,
  });
}

export function sseOk(res: ServerResponse, headers: Record<string, string> = {}) {
  res.writeHead(200, { "content-type": "text/event-stream", ...headers });
  res.write(`event: response.created\ndata: {"type":"response.created"}\n\n`);
  res.end(
    `event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}}\n\n`,
  );
}

export async function close(...servers: http.Server[]) {
  await Promise.all(
    servers.map((server) => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    }),
  );
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(condition: () => boolean, timeoutMs = 5_000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await sleep(5);
  }
}

function listen(server: http.Server) {
  return new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function port(server: http.Server) {
  return (server.address() as AddressInfo).port;
}
