# DeepSeek Latch Gateway — Project Structure

## Directory Layout

```text
deepseek-latch-gateway/
├── AGENTS.md                   # AI pair programming guidelines (managed by agent-rules)
├── CLAUDE.md                   # Symlink to AGENTS.md
├── docs/                       # Project documentation
│   ├── overview.md             # Project purpose and domain
│   ├── structure.md            # Directory and module boundaries
│   ├── notes.md                # Technical gotchas and architectural rationale
│   ├── plan.md                 # Current implementation plan
│   └── roadmap.md              # Future evolution and backlog
├── src/                        # Gateway source code
│   ├── types.ts                # Config interfaces (providers, deployments)
│   ├── config.ts               # config.yaml parser with env expansion and validation
│   ├── router.ts               # Ordered deployments and 30-minute cooldown state
│   ├── proxy.ts                # Request validation, failover loop, compat bridges, SSE passthrough
│   ├── latest.ts               # "Newest DeepSeek model" rules and live provider check
│   ├── redact.ts               # Credential redaction for logged upstream text
│   ├── check-latest.ts         # `bun run check-latest` entry point
│   └── index.ts                # Bun HTTP server & management endpoints (/healthz, /status)
├── tests/                      # Test suite
│   ├── helpers.ts              # Fetch mock and config builders
│   ├── config.test.ts          # Config parsing and shipped-example rules
│   ├── proxy.test.ts           # Failover, cooldown, validation and compat
│   ├── latest.test.ts          # Newest-model rules and check-latest
│   ├── session-header.test.ts  # OpenCode session affinity and User-Agent
│   └── server-timeout.test.ts  # Streaming idle timeout
├── config.example.yaml         # Provider and model configuration template
├── package.json                # Project manifest and scripts
├── tsconfig.json               # TypeScript compiler options
└── .github/
    └── workflows/
        └── ci.yml              # GitHub Actions CI pipeline
```

## Module Boundaries
- **`router.ts`**: Which deployments are available and their cooldown/statistics; no HTTP.
- **`proxy.ts`**: HTTP forwarding, failure classification and compat bridges.
- **`config.ts`**: Configuration loading, environment resolution and validation.
- **`latest.ts`**: Model-name parsing and the newest-model checks.
- **`index.ts`**: Server lifecycle and management endpoints.
