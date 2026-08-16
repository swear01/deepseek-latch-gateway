# DeepSeek Latch Gateway — Architectural Notes & Gotchas

## Key Design Rationale

### 1. Why RS-Latch instead of Generic Round-Robin?
Generic load balancers alternate requests between Key 1 and Key 2. When accounts have daily or hourly burst limits, alternating requests causes both accounts to hit rate limits simultaneously. 
The RS-Latch stays on Key 1 until it fails, giving Key 2 maximum recovery/cooldown time before it is ever touched. Once Key 1 exhausts, Key 2 takes over 100% of the workload.

### 2. Debounced Concurrency
When a high-concurrency burst occurs (e.g. Swear Review OCR spawning multiple concurrent requests or DeepSeek Harness running batches), multiple requests may receive 429 at the exact same millisecond.
Without a debounce window, 10 concurrent 429s would increment the pointer 10 times, cycling through the entire key pool immediately.
The gateway maintains `lastSwitchTimestamp` with a configurable debounce window (default 1.0s). Concurrent 429s from the same old index will adopt the new index and retry without advancing the pointer again.

### 3. In-Flight Retry Guarantee
The client request body is read once into memory before upstream forwarding. If the initial upstream request fails with 429 at the HTTP status header stage, the connection is discarded before any downstream headers are sent to the client. The request is immediately retried on the newly switched key, making the failover 100% transparent to the client.

### 4. Zero-Copy Streaming
Once upstream responds with `200 OK`, `upstreamResponse.body` is streamed directly to the client response stream. DeepSeek `reasoning_content` and SSE event chunks are preserved without deserialization overhead.

## Official Contract & Compat Gotchas (實測 2026-08-16)

### 5. Client-facing contract is DeepSeek official — endpoints declare deviations
Clients always send official-shape requests (`response_format: {type:"json_object"}`,
`thinking`, `reasoning_effort`); per-endpoint `compat` bridges deviations at the
proxy layer. Never ask a client to work around an endpoint (e.g. harness
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
- Command Code emits `reasoning` deltas **even when `thinking: {"type":"disabled"}`**; the SSE rewrite handles them regardless.

### 7. SSE rewriting is conservative
Only endpoints declaring `response_reasoning_field` get the `TransformStream`
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
OpenCode Go answers quota exhaustion with a **429 JSON body**
(`{"type":"error","error":{"type":"GoUsageLimitError","message":"Weekly usage
limit reached..."}}`, not SSE) — `isRateLimitOrQuotaError` matches status 429
and `weekly usage limit` so the latch still flips. Key 1 was
observed at weekly limit while key 2 stayed healthy.
