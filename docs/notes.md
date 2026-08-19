# DeepSeek Latch Gateway — Architectural Notes & Gotchas

## Key Design Rationale

### 1. Why hierarchical RS-Latch instead of a flat pool?
Generic load balancers alternate requests between all keys. When accounts have
usage limits, that can exhaust every account concurrently. The gateway keeps an
inner RS-Latch for the highest-priority OpenCode group, so later accounts are
untouched until the active account fails. Only when the whole group is
exhausted does the outer route enter the lower-priority Command Code group.

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
- Post-deploy re-probe (2026-08-16): opencode-go **key 2 currently accepts** `response_format` (200) with thinking on/off and both models; the 400 was observed on key 1 (pre-quota). Keep `strip_response_format` on opencode-go anyway — it is a protective bridge, harmless when the upstream accepts the param.
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

### 11. Provider and routing configuration are separate

`config.yaml` defines provider endpoints and compatibility behavior. `routing.yaml`
defines model routes, explicit numeric priorities, per-group latch membership,
and route-level `upstream_model` names. A provider may be referenced by more
than one route; Command Code is shared by Flash fallback and Pro routing.

### 12. Priority exhaustion does not immediately fail back

The outer priority latch advances only toward lower priorities. Once the final
group is reached, a failed request returns 429 after visiting the route once;
it does not immediately retry an already exhausted higher-priority group.
