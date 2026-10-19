import { SlidingWindowBudget } from "./budget.ts";
import { loadConfig } from "./config.ts";
import { Governor } from "./governor.ts";
import { consoleLogger as log, fmt } from "./log.ts";
import { Metrics } from "./metrics.ts";
import { createProxyServer } from "./proxy.ts";

let config;
try {
  config = loadConfig();
} catch (error) {
  console.error(`configuration error: ${(error as Error).message}`);
  process.exit(1);
}

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

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    console.error(`port ${config.port} on ${config.host} is already in use — set PORT=<free port> and update Codex's base_url`);
  } else {
    console.error(`could not start governor: ${error.message}`);
  }
  process.exit(1);
});

server.listen(config.port, config.host, () => {
  log(
    `governor listening on http://${config.host}:${config.port} → ${config.upstream.origin}${config.upstream.pathname} ` +
      `(target ${fmt(config.tpmTarget)} of ${fmt(config.azureTpmLimit)} TPM, window ${fmt(config.windowMs)}ms, ` +
      `api key ${config.apiKey ? "configured" : "from client"})`,
  );
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log(`${signal} received, shutting down`);
    server.close();
    server.closeAllConnections();
    process.exit(0);
  });
}
