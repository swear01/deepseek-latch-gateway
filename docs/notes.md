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
