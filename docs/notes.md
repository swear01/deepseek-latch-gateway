# DeepSeek Latch Gateway — Architectural Notes & Gotchas

## Key Design Rationale

### 1. Why an ordered list with cooldown instead of priority groups and latches?
Generic load balancers alternate requests between all keys, which can exhaust
every subscription account at once. An ordered list gives the same "stay on the
first working account" behavior: later deployments are only used while earlier
ones are cooling down. The earlier design (priority groups, an inner RS-Latch per
group, a debounced pointer, half-open probes, exponential cooldowns and a
separate `routing.yaml`) produced the same order with far more state, and let
one public model id map to different snapshots per fallback. It was replaced on
2026-10-25 by LiteLLM's shape: one public name, ordered deployments, cooldown.

### 2. Cooldown is flat, per deployment, and also covers network failures
Any provider failure pauses that deployment (provider + model) for 30 minutes;
the next request after that tries it again. Because state is per deployment,
concurrent failures just rewrite the same expiry, so no debounce is needed, and
a model missing on one provider does not block that provider's other models.
A single network failure is retried once on the same provider first, so one
dropped connection does not cost 30 minutes. When everything is cooling down
the client gets 503 with `Retry-After` instead of the gateway poking a provider
inside its cooldown.

### 3. In-Flight Retry Guarantee
The client request body is read once into memory before upstream forwarding. If
an upstream fails at the HTTP status stage, its response is discarded before any
downstream headers are sent, and the request is retried on the next deployment,
so failover is transparent to the client.

### 4. Zero-Copy Streaming
Once upstream responds with `200 OK`, `upstreamResponse.body` is streamed directly to the client response stream. DeepSeek `reasoning_content` and SSE event chunks are preserved without deserialization overhead.

## Official Contract & Compat Gotchas (實測 2026-08-16)

### 5. Client-facing contract is DeepSeek official — providers declare deviations
Clients always send official-shape requests (`response_format: {type:"json_object"}`,
`thinking`, `reasoning_effort`); per-provider `compat` bridges deviations at the
proxy layer. Never ask a client to work around a provider (e.g. harness
`VGUIDE_LLM_JSON_MODE=off` is obsolete once compat is deployed).

### 6. Upstream deviation matrix (empirical)

| upstream | `response_format` | non-streaming reasoning | streaming reasoning | errors |
|---|---|---|---|---|
| DeepSeek official | supported | `message.reasoning_content` | `delta.reasoning_content` | single-layer |
| Command Code | **400** `Invalid input`, param=`response_format` (double-wrapped) | `message.reasoning` + `message.reasoning_details` | `delta.reasoning` + `delta.reasoning_details` | **double-wrapped** error bodies |
| OpenCode Go | **400** `Prompt must contain the word 'json'` | `message.reasoning_content` (official) | `delta.reasoning_content` (official) | `{"type":"error","error":{...}}` JSON body with e.g. 402 GoUsageLimitError |

Consequences:
- Command Code needs `strip_response_format` + `response_reasoning_field: "reasoning"` + `unwrap_error`.
- OpenCode Go needs only `strip_response_format` — its reasoning fields are already official, so SSE stays zero-copy.
- Post-deploy re-probe (2026-08-16): opencode-go **key 2 currently accepts** `response_format` (200) with thinking on/off and both models; the 400 was observed on key 1 (pre-quota). Keep `strip_response_format` on opencode-go anyway — it is a protective bridge, harmless when the upstream accepts the param.
- Command Code emits `reasoning` deltas **even when `thinking: {"type":"disabled"}`**; the SSE rewrite handles them regardless.

### 7. SSE rewriting is conservative
Only providers declaring `response_reasoning_field` get the `TransformStream`
line rewrite. Lines that fail JSON parse (incl. `data: [DONE]`) pass through
verbatim; `\r` is stripped per line; chunk boundaries are buffered so events
split across TCP chunks still rewrite correctly.

### 8. Error unwrap is shape-checked
The unwrap only fires when `error.message` is itself a JSON string containing
an `error` object. Anything else (plain message, malformed JSON) is forwarded
verbatim — never fabricate an error shape.

### 9. `json_schema` is rejected at the router
Official chat completions support only `json_object`. A `response_format.type`
of `json_schema` (or a malformed `response_format`) gets an official-style 400
`invalid_request_error` with `param: response_format` **before** any upstream
call, so no client can depend on out-of-contract endpoint capability.

### 10. OpenCode Go account usage limits
OpenCode Go answers subscription quota exhaustion with a **429 JSON body**
(`{"type":"error","error":{"type":"GoUsageLimitError","message":"Weekly usage
limit reached..."}}`, not SSE). Key 1 was observed at weekly limit while key 2
stayed healthy.

Zen **balance** exhaustion is a different shape: HTTP **401**
(`{"type":"error","error":{"type":"CreditsError","message":"Insufficient
balance..."}}`). An expired key (`api_key_expired`, after the October 2026
OpenCode key revocation) is also a 401. An inactive Go subscription returns
HTTP **403** with `An active OpenCode Go subscription is required to use Go
models.` All of these are provider failures: the deployment cools down for 30
minutes and the request moves to the next one. Ordinary permission-denied 403
responses still reach the client unchanged.

### 11. One configuration file

`config.yaml` holds `providers` (connection and compat settings) and `models`
(public id -> ordered deployments). A provider can appear under several models
with different upstream model names; Command Code serves both Flash and Pro.
The model keys are the allowlist; versioned, dated and prefixed DeepSeek names
(`deepseek-v4-flash`, `deepseek-v4.1-flash-1017`, `deepseek/deepseek-v4-pro`)
alias to the unversioned key of the same family, so clients that still send an
old id keep working and always get the newest model. The old `endpoints` list
and `routing.yaml` are rejected at startup.

### 12. "Newest DeepSeek" is checked, not pinned

OpenCode Go and Command Code list only undated names (`deepseek-v4.1-flash`,
`deepseek/deepseek-v4-pro`), so the gateway cannot pin or verify their snapshot
dates. OpenRouter lists dated snapshots; its undated `deepseek/deepseek-v4.1-flash`
is the 0910 release, while `~deepseek/deepseek-flash-latest` resolved to
`deepseek/deepseek-v4.1-flash-1017` and `~deepseek/deepseek-pro-latest` to
`deepseek/deepseek-v4-pro-0813` on 2026-10-25. `check-latest` treats the
newest entry as the highest version, then the most recent `created` time.
With the existing `max_price` cap ($0.15 / $0.60 per M), pro-latest is served
by Baidu.

### 13. Oracle ARM64 build target is pinned

Oracle runs a Neoverse-N1 ARM64 host. A `bun-linux-arm64` standalone binary
built with Bun 1.3.14 crashed in `Bun.serve` with `SIGBUS`, while a binary built
targeting `bun-linux-arm64-v1.3.13` started successfully. The package script
pins the ARM64 target to v1.3.13; do not replace it with the unversioned target
without retesting on Oracle.

### 14. The configured timeout also governs downstream idle connections

Bun closes an otherwise healthy streaming response after 10 seconds without a
chunk unless `Bun.serve` receives `idleTimeout`. The gateway passes
`server.timeout_seconds` to that setting so a quiet upstream stream can remain
open for the same duration as the upstream request timeout.

### 15. Replace the running standalone binary atomically

Never use `cp` or `install` directly onto `~/.local/bin/deepseek-gateway` while
the service is running. Truncating the mapped executable can trigger SIGBUS and
an auto-restart may execute the partially written file. Stage the complete
binary in `/tmp`, set its mode, then use `mv` to replace the path atomically
before restarting the service.

### 16. Outbound User-Agent normalization and 403 block failover

OpenCode Go / Cloudflare blocks requests with generic library User-Agents such as
`Python-urllib/*` with HTTP 403 / Cloudflare Error 1010. The gateway normalizes
missing or generic library User-Agents to `aisimpv-gateway/1.0`, while preserving
explicit custom agent User-Agents. In addition, HTTP 403 / Cloudflare 1010 is
a provider failure: the deployment cools down for 30 minutes and the request
fails over to the next deployment instead of aborting.
