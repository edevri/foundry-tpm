export interface Config {
  port: number;
  host: string;
  /** Origin requests are forwarded to, e.g. https://my-resource.openai.azure.com */
  upstream: URL;
  /** Injected as `api-key` only when the client sends no credentials of its own. */
  apiKey: string | undefined;
  /** Appended as `api-version` only when the client's URL lacks one. */
  apiVersion: string | undefined;
  azureTpmLimit: number;
  tpmTarget: number;
  windowMs: number;
  maxQueueDepth: number;
  maxQueueWaitMs: number;
  maxInternal429Retries: number;
  /** Fallback wait after a rate-limit 429 that carries no Retry-After hint. */
  default429BackoffMs: number;
  /** Output reservation when the request sets no max_output_tokens / max_tokens. */
  defaultOutputReservation: number;
  charsPerToken: number;
  maxRequestBodyBytes: number;
}

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env): Config {
  const endpoint = env.AZURE_OPENAI_ENDPOINT;
  if (!endpoint) throw new Error("AZURE_OPENAI_ENDPOINT is required");
  let upstream: URL;
  try {
    upstream = new URL(endpoint);
  } catch {
    throw new Error(`AZURE_OPENAI_ENDPOINT is not a valid URL: ${endpoint}`);
  }
  if (upstream.protocol !== "https:" && upstream.protocol !== "http:") {
    throw new Error("AZURE_OPENAI_ENDPOINT must be an http(s) URL");
  }

  const azureTpmLimit = int(env, "AZURE_TPM_LIMIT", 250_000);
  const tpmTarget = int(env, "GOVERNOR_TPM_TARGET", 225_000);
  if (tpmTarget > azureTpmLimit) {
    throw new Error("GOVERNOR_TPM_TARGET must not exceed AZURE_TPM_LIMIT");
  }

  return {
    port: int(env, "PORT", 8788, 0),
    host: env.HOST || "127.0.0.1",
    upstream,
    apiKey: env.AZURE_OPENAI_API_KEY || undefined,
    apiVersion: env.AZURE_OPENAI_API_VERSION || undefined,
    azureTpmLimit,
    tpmTarget,
    windowMs: int(env, "GOVERNOR_WINDOW_MS", 60_000),
    maxQueueDepth: int(env, "MAX_QUEUE_DEPTH", 100, 0),
    maxQueueWaitMs: int(env, "MAX_QUEUE_WAIT_MS", 120_000),
    maxInternal429Retries: int(env, "MAX_INTERNAL_429_RETRIES", 5, 0),
    default429BackoffMs: int(env, "DEFAULT_429_BACKOFF_MS", 10_000),
    defaultOutputReservation: int(env, "DEFAULT_OUTPUT_RESERVATION", 8_192, 0),
    charsPerToken: positive(env, "CHARS_PER_TOKEN", 3.5),
    maxRequestBodyBytes: int(env, "MAX_REQUEST_BODY_BYTES", 64 * 1024 * 1024),
  };
}

function int(env: Env, name: string, fallback: number, min = 1): number {
  const value = num(env, name, fallback);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(`${name} must be an integer >= ${min}`);
  }
  return value;
}

function positive(env: Env, name: string, fallback: number): number {
  const value = num(env, name, fallback);
  if (value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

function num(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a number, got "${raw}"`);
  }
  return value;
}
