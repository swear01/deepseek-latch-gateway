# DeepSeek Latch Gateway — Overview

`deepseek-latch-gateway` is a lightweight OpenAI-compatible gateway for DeepSeek
models across OpenCode Go accounts, Command Code and OpenRouter.

## Routing model

Configuration follows LiteLLM's shape in a single `config.yaml`:

- `providers` holds URLs, credentials and compatibility bridges.
- `models` maps each public model id (`deepseek-flash`, `deepseek-pro`) to an
  ordered list of deployments (`provider` + upstream `model`).
- A request uses the first deployment that is not cooling down. Any provider
  failure (quota, credentials, block, 408, 5xx, network) pauses that
  deployment for 30 minutes.
- Deployments always name the newest DeepSeek model: undated names on
  OpenCode Go and Command Code, `~deepseek/deepseek-*-latest` on OpenRouter.
  `bun run check-latest` verifies this against the live providers.

`deepseek-flash` tries OpenCode accounts 1, 2 and 3, then Command Code, then
OpenRouter. `deepseek-pro` tries Command Code, then OpenRouter.

## Target consumers

1. Pi Agent across the HAPI fleet.
2. DeepSeek Harness for evaluation and benchmarking.
3. Any standard OpenAI-compatible client.

Swear Review is an external consumer and is not modified by this project.
