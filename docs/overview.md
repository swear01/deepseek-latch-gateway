# DeepSeek Latch Gateway — Overview

## Project Overview

`deepseek-latch-gateway` is a specialized, lightweight AI reverse proxy and gateway designed for **DeepSeek series models** (`deepseek-v4-flash`, `deepseek-v4-pro`, `deepseek-chat`, `deepseek-reasoner`) and **OpenCode Go multi-subscription accounts**.

## The Problem
Power users subscribing to multiple OpenCode Go or DeepSeek accounts often hit hourly or daily token limits. Generic load balancers alternate traffic across keys, exhausting both concurrently. Standard fallbacks repeatedly hit failed keys before retrying, adding latency to every request.

## The Solution: RS-Latch State Machine
`deepseek-latch-gateway` implements a stateful **RS-Latch (Bistable Sticky Failover)**:
- Requests stick to Key 1 until it returns `429 Too Many Requests` or Quota Exceeded.
- Upon 429, the latch flips to Key 2, immediately retries the in-flight request, and locks all subsequent requests to Key 2.
- When Key 2 eventually hits 429, the latch flips back to Key 1 (or the next configured endpoint).
- Debounce mechanisms prevent concurrent thundering herds from flipping the latch multiple times.

## Target Consumers
1. **Pi Agent** across 7 HAPI fleet machines (`swairM5`, `mazu`, `athena`, `valkyrie`, `cthulhu`, `zeus`, `oracle`).
2. **Swear Review** on Oracle Cloud (`/opt/swear-review`).
3. **DeepSeek Harness** (Evaluation & benchmarking pipelines).
4. Any standard OpenAI / Anthropic compatible client.
