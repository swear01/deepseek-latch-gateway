# DeepSeek Latch Gateway — Overview

`deepseek-latch-gateway` is a lightweight OpenAI-compatible gateway for DeepSeek
models and multiple OpenCode Go accounts.

## Routing model

Routing is hierarchical rather than a flat endpoint list:

- Priority 1 is an RS-Latch group containing the OpenCode Go accounts.
- Priority 2 is the Command Code fallback group.
- A group is exhausted before the outer route advances to the next priority.
- Route-specific upstream model names are kept in `routing.yaml`.
- Provider URLs, credentials, and compatibility behavior remain in `config.yaml`.

The Flash route therefore tries OpenCode accounts 1, 2, and 3 before using
Command Code with `deepseek/deepseek-v4-flash`. The Pro route references the
same Command Code provider with `deepseek/deepseek-v4-pro`.

## Target consumers

1. Pi Agent across the HAPI fleet.
2. DeepSeek Harness for evaluation and benchmarking.
3. Any standard OpenAI-compatible client.

Swear Review is an external consumer and is not modified by this project.
