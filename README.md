# foundry-tpm — Azure TPM governor

A small local proxy between Codex (T3 Code sessions) and one Azure OpenAI / Foundry deployment. All sessions share one
global tokens-per-minute budget. When a request would push past it, the proxy **holds the request open in a FIFO queue**
until there is capacity. Codex sees extra latency, not a 429.

```
Codex sessions ──▶ http://127.0.0.1:8788/<same path> ──▶ governor (225k TPM target, queue) ──▶ Azure (250k TPM)
```

No runtime dependencies. Node ≥ 24 runs the TypeScript directly.

## Run

```sh
export AZURE_OPENAI_ENDPOINT=https://<resource>.openai.azure.com   # origin only; paths are forwarded verbatim
export AZURE_OPENAI_API_KEY=...                                     # optional, see Authentication
npm start
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `AZURE_OPENAI_ENDPOINT` | — (required) | Upstream origin (a path prefix is allowed and prepended) |
| `AZURE_OPENAI_API_KEY` | — | Sent as `api-key` **only** when the client sends no `authorization`/`api-key` |
| `AZURE_OPENAI_API_VERSION` | — | Added as `?api-version=` when missing (not for `/openai/v1/...` paths) |
| `PORT` / `HOST` | `8788` / `127.0.0.1` | Listen address |
| `AZURE_TPM_LIMIT` | `250000` | Deployment allocation |
| `GOVERNOR_TPM_TARGET` | `225000` | What the governor admits per window |
| `GOVERNOR_WINDOW_MS` | `60000` | Window length |
| `MAX_QUEUE_DEPTH` | `100` | Beyond this: `503 governor_queue_full` |
| `MAX_QUEUE_WAIT_MS` | `120000` | Total wait budget per request (queue + internal 429 retries): then `503 governor_timeout` |
| `MAX_INTERNAL_429_RETRIES` | `5` | Azure 429s absorbed per request before passing one through |
| `DEFAULT_429_BACKOFF_MS` | `10000` | Wait after a 429 with no `Retry-After`/reset hint |
| `DEFAULT_OUTPUT_RESERVATION` | `8192` | Output tokens reserved when the request sets no `max_output_tokens`/`max_tokens` (Codex normally sets none) |
| `CHARS_PER_TOKEN` | `3.5` | Prompt estimator divisor (lower = more conservative) |

`GET /governor/status` returns the budget, queue depth, Azure's last reported state and the metrics as JSON.
`GET /governor/health` is a liveness check.

### As a systemd user service

```sh
mkdir -p ~/.config/foundry-tpm
install -m 600 /dev/null ~/.config/foundry-tpm/env
echo 'AZURE_OPENAI_ENDPOINT=https://<resource>.openai.azure.com' >> ~/.config/foundry-tpm/env   # plus any variables above
cp systemd/foundry-tpm.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now foundry-tpm
journalctl --user -u foundry-tpm -f      # the governor log
```

The unit runs `src/main.ts` from this checkout, so restart it after pulling changes
(`systemctl --user restart foundry-tpm`). To keep it running while you are logged out, run
`loginctl enable-linger $USER`.

## Pointing Codex at it

Codex is configured the same way as for Azure directly. Only `base_url` changes. To keep your normal Codex setup
untouched, give the governed setup its own Codex home and run `CODEX_HOME=~/.codex-tpm codex ...`:

```toml
# ~/.codex-tpm/config.toml
model = "<deployment name>"
model_provider = "azure"

[model_providers.azure]
name = "Azure"
base_url = "http://127.0.0.1:8788/openai/v1"     # was https://<resource>.openai.azure.com/openai/v1
env_key = "AZURE_OPENAI_API_KEY"
wire_api = "responses"
# Legacy deployment-style URLs work too:
# base_url = "http://127.0.0.1:8788/openai"
# query_params = { api-version = "2025-04-01-preview" }
```

**Azure detection caveat:** Codex switches on Azure-specific Responses behaviour (e.g. `store: true`, keeping item ids)
when the base URL contains `openai.azure.`, `cognitiveservices.azure.`, `azure-api.` etc., and also (per the Codex
source) when the provider is named `Azure`. A `localhost` URL loses the URL match, so keep `name = "Azure"`. If Azure
then rejects follow-up turns about missing items/ids, alias a matching hostname instead:

```sh
echo '127.0.0.1 governor.openai.azure.local' | sudo tee -a /etc/hosts
# base_url = "http://governor.openai.azure.local:8788/openai/v1"
```

## Authentication

Whatever credentials Codex sends (`authorization: Bearer …` or `api-key`) are forwarded untouched. If you would rather
keep the key out of Codex, set `AZURE_OPENAI_API_KEY` on the proxy instead and give Codex a dummy key. Header values
are never logged.

## How admission works

1. **Estimate.** Azure admits a request against TPM *before* generating, from a character count of the prompt plus
   the requested output limit. The governor does the same thing: prompt characters ÷ `CHARS_PER_TOKEN` (inline images
   and `encrypted_content` reasoning blobs are costed separately so base64 does not inflate them), plus
   `max_output_tokens` / `max_completion_tokens` / `max_tokens` (× `n`), or `DEFAULT_OUTPUT_RESERVATION`.
   gzip/deflate/br/zstd request bodies are decoded for estimation. The original bytes are forwarded.
2. **Reserve.** A sliding window (`src/budget.ts`): every reservation counts against the target for one full window.
   Reservation is a synchronous check-and-debit, so concurrent requests cannot both claim the same capacity. A request
   whose reservation exceeds the target can never fit and gets `413 reservation_too_large` immediately.
3. **Queue.** Strict FIFO. Wakeups are scheduled for the moment the head request's tokens free up, so nothing
   busy-loops. A client that disconnects while queued is removed.
4. **Reconcile.** On every Azure response the `x-ratelimit-*-tokens` headers are compared with the local view, after
   reserving the safety margin (`AZURE_TPM_LIMIT − GOVERNOR_TPM_TARGET`) and the requests sent since this one. If Azure
   reports less headroom, the difference is debited until Azure's reset/Retry-After time. Headers only ever
   **tighten** the model: an over-estimate costs throughput, an under-estimate costs Codex a 429.
5. **429s anyway.** A rate-limit 429 (TPM, RPM or unrecognised) is drained, logged as `UNEXPECTED`, pauses *all*
   admissions until `retry-after-ms` / `retry-after` / `x-ratelimit-reset-tokens`, and the request goes back to the
   **front** of the queue. After `MAX_INTERNAL_429_RETRIES`, or once its wait budget is spent, the 429 is passed through.
   Quota/billing 429s are passed through immediately.

Responses stream through chunk by chunk with backpressure. If the client disconnects mid-stream, the upstream request
is aborted. The final `usage` is read from the stream and logged next to the estimate (`ratio` = estimated/actual
input). Use it to tune `CHARS_PER_TOKEN`.

## Tests

```sh
npm test         # unit tests + a fake upstream simulating streaming, rate-limit headers, 429/Retry-After
npm run typecheck
```

## Known limitations (v1)

- Queued requests are lost on restart.
- WebSocket upgrades are not proxied. If a Codex build tries Responses-over-WebSocket for this provider, turn that
  feature off so it uses HTTP+SSE.
- A request estimated above `GOVERNOR_TPM_TARGET` (225k) is rejected even though Azure's 250k could admit it. That
  matters for very long Codex contexts. Raise the target or lower `DEFAULT_OUTPUT_RESERVATION` if you hit it.
