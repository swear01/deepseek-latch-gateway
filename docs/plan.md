# DeepSeek Latch Gateway — Current Plan

## Phase 1: MVP Core (Current Milestone)
- [x] Initial project scaffolding with Bun + TypeScript.
- [x] `agents_rule` setup and documentation.
- [x] RS-Latch state machine with debounce & stats tracking (`src/latch.ts`).
- [x] Transparent SSE reverse proxy with in-flight 429 retry (`src/proxy.ts`).
- [x] YAML / JSON configuration loader with env variable interpolation (`src/config.ts`).
- [x] Management endpoints (`GET /healthz`, `GET /status`, `POST /switch`) (`src/index.ts`).
- [x] Comprehensive test suite for latch state transitions and proxy retries.
- [x] CI workflow with automated test and standalone binary compile.

## Phase 2: Local Verification & Service Setup
- [ ] Local testing on Mac (`swairM5`) with simulated 429 failovers.
- [ ] Setup LaunchAgent `~/Library/LaunchAgents/com.swear.deepseek-gateway.plist`.
- [ ] Connect local Pi Agent and DeepSeek Harness.

## Phase 3: Oracle & Fleet Rollout
- [ ] Deploy to Oracle Cloud (`deepseek-gateway.service`) with memory cgroups.
- [ ] Update `swear-review` configuration (`llm.url: http://127.0.0.1:35001/v1/chat/completions`).
- [ ] Deploy to remaining Linux nodes in the HAPI fleet (`mazu`, `athena`, `valkyrie`, `cthulhu`, `zeus`).
