# DeepSeek Latch Gateway — Roadmap

## Backlog & Future Enhancements

### 1. Additional Provider Adapters
- Official DeepSeek API (`api.deepseek.com`).
- SiliconCloud / SiliconFlow OpenAI-compatible endpoints.
- Self-hosted Ollama / vLLM DeepSeek instances.

### 2. Advanced Metrics & Telemetry
- Prometheus `/metrics` endpoint exporting:
  - Token counts (input tokens, output tokens, prompt cache hit/miss).
  - Failover and cooldown counters per deployment.
  - Per-endpoint latency percentiles (p50, p95, p99).

### 3. Notifications & Webhooks
- Optional Discord / Telegram webhook notification when a deployment cools down or every deployment of a model is unavailable.
