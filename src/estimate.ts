import zlib from "node:zlib";

export interface Estimate {
  inputTokens: number;
  outputTokens: number;
  /** What we reserve against the budget: input + output. */
  total: number;
  /** Where the output reservation came from, for logs. */
  outputSource: string;
}

export interface EstimatorOptions {
  charsPerToken: number;
  defaultOutputReservation: number;
}

/** Rough per-image cost; Azure's estimator does not see decoded pixels either. */
const IMAGE_TOKENS = 1_600;
/** Base64 → bytes is 3/4; ciphertext is about as long as its plaintext, ~4 bytes per token. */
const ENCRYPTED_CHARS_PER_TOKEN = 16 / 3;
const OUTPUT_LIMIT_FIELDS = ["max_output_tokens", "max_completion_tokens", "max_tokens"] as const;

/**
 * Azure admits a request against TPM before generating anything, using a character-count estimate of
 * the prompt plus the requested output limit. We mirror that: count prompt characters (rather than
 * running a tokenizer Azure itself does not use) and reserve the declared output limit.
 */
export function estimateRequest(body: unknown, options: EstimatorOptions): Estimate {
  const inputTokens = Math.ceil(countPromptTokens(body, options.charsPerToken));
  let outputTokens = options.defaultOutputReservation;
  let outputSource = "default";
  if (isRecord(body)) {
    for (const field of OUTPUT_LIMIT_FIELDS) {
      const value = body[field];
      if (typeof value === "number" && value > 0) {
        outputTokens = Math.ceil(value);
        outputSource = field;
        break;
      }
    }
    const choices = typeof body.n === "number" && body.n > 1 ? body.n : 1;
    outputTokens *= choices;
  }
  return { inputTokens, outputTokens, total: inputTokens + outputTokens, outputSource };
}

function countPromptTokens(value: unknown, charsPerToken: number, key?: string): number {
  if (typeof value === "string") {
    if (value.startsWith("data:image/")) return IMAGE_TOKENS;
    if (key === "encrypted_content") return value.length / ENCRYPTED_CHARS_PER_TOKEN;
    return value.length / charsPerToken;
  }
  if (Array.isArray(value)) {
    let sum = 0;
    for (const item of value) sum += countPromptTokens(item, charsPerToken);
    return sum;
  }
  if (isRecord(value)) {
    // Keys and structure are part of what gets serialized into the prompt (tool schemas especially).
    let sum = 1;
    for (const [k, v] of Object.entries(value)) {
      sum += k.length / charsPerToken + countPromptTokens(v, charsPerToken, k);
    }
    return sum;
  }
  return 0;
}

/** Decodes a request body for inspection. The original bytes are what gets forwarded. */
export function decodeBody(raw: Buffer, contentEncoding: string | undefined): Buffer {
  switch (contentEncoding?.trim().toLowerCase()) {
    case undefined:
    case "":
    case "identity":
      return raw;
    case "gzip":
    case "x-gzip":
      return zlib.gunzipSync(raw);
    case "deflate":
      return zlib.inflateSync(raw);
    case "br":
      return zlib.brotliDecompressSync(raw);
    case "zstd":
      return zlib.zstdDecompressSync(raw);
    default:
      throw new Error(`unsupported content-encoding: ${contentEncoding}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
