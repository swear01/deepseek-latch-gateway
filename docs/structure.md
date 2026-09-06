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
│   ├── config.ts               # Provider/runtime config parser with env expansion
│   ├── routing.ts              # Independent priority-group routing loader/resolver
│   ├── latch.ts                # Flat RS-Latch compatibility state machine
│   ├── priority-latch.ts       # Hierarchical priority group + inner latch state
│   ├── proxy.ts                # Transparent SSE reverse proxy & retry logic
│   └── index.ts                # Bun HTTP server & management endpoints (/healthz, /status, /switch)
├── tests/                      # Test suite
│   ├── latch.test.ts           # Flat state machine unit & concurrency tests
│   ├── routing.test.ts         # Routing schema and priority state tests
│   ├── priority-proxy.test.ts  # Hierarchical failover integration tests
│   └── proxy.test.ts           # Proxy, compatibility, and streaming tests
├── config.example.yaml         # Provider/runtime configuration template
├── routing.example.yaml        # Model priority and upstream mapping template
├── package.json                # Project manifest and scripts
├── tsconfig.json               # TypeScript compiler options
└── .github/
    └── workflows/
        └── ci.yml              # GitHub Actions CI pipeline
```

## Module Boundaries
- **`latch.ts`**: Flat RS-Latch compatibility state management.
- **`priority-latch.ts`**: Outer priority traversal and per-group latch state; contains no HTTP transport logic.
- **`routing.ts`**: Loads and validates model routes independently from provider definitions.
- **`proxy.ts`**: HTTP forwarding and retry pipeline; applies route-level upstream model mapping.
- **`config.ts`**: Provider/runtime configuration loading and environment resolution.
- **`index.ts`**: Server lifecycle and management endpoints.
