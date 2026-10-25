# DeepSeek Latch Gateway — Current Plan

## Phase 1: Simplified router (2026-10-25)
- [x] Single `config.yaml`: `providers` plus ordered `models` deployments.
- [x] Flat 30-minute per-deployment cooldown for every provider failure.
- [x] Remove priority groups, latches, `routing.yaml`, aliases, model maps, allowlist and `/switch`.
- [x] Only `deepseek-flash` and `deepseek-pro`, each targeting the newest model.
- [x] `check-latest` live verification and unit rules against pinned snapshots.

## Phase 2: Fleet rollout
- [ ] Convert each host's live config to the new format and install the new binary.
- [ ] Verify health, model list, Flash and Pro inference, removed ids and `check-latest` on each host.

`swear-review` is not modified or deployed by this project.
