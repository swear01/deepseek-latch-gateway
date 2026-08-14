# DeepSeek Latch Gateway — Roadmap

## Backlog & Future Enhancements

### 1. Additional Provider Adapters
- Official DeepSeek API (`api.deepseek.com`).
- SiliconCloud / SiliconFlow OpenAI-compatible endpoints.
- Self-hosted Ollama / vLLM DeepSeek instances.

### 2. Advanced Metrics & Telemetry
- Prometheus `/metrics` endpoint exporting:
  - Token counts (input tokens, output tokens, prompt cache hit/miss).
  - Latch flip counter and active index gauge.
  - Per-endpoint latency percentiles (p50, p95, p99).

### 3. Notifications & Webhooks
- Optional Discord / Telegram webhook notification on latch flips or when all keys are exhausted.
