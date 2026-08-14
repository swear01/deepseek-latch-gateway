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
│   ├── types.ts                # TypeScript interfaces (GatewayConfig, Stats, Status)
│   ├── config.ts               # Configuration parser with env variable expansion
│   ├── latch.ts                # RS-Latch state machine with debounce & stats tracking
│   ├── proxy.ts                # Transparent SSE reverse proxy & in-flight retry logic
│   └── index.ts                # Bun HTTP server & management endpoints (/healthz, /status, /switch)
├── tests/                      # Test suite
│   ├── latch.test.ts           # State machine unit & concurrency tests
│   └── proxy.test.ts           # End-to-end proxy, failover, and streaming tests
├── config.example.yaml         # Configuration template
├── package.json                # Project manifest and scripts
├── tsconfig.json               # TypeScript compiler options
└── .github/
    └── workflows/
        └── ci.yml              # GitHub Actions CI pipeline
```

## Module Boundaries
- **`latch.ts`**: Pure state management. Contains no HTTP transport logic.
- **`proxy.ts`**: HTTP forwarding and retry pipeline. Reads state from `latch.ts` and notifies `latch.ts` on failures.
- **`config.ts`**: Static configuration loading and environment resolution.
- **`index.ts`**: Server lifecycle, routing, and management endpoints.
