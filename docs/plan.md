# DeepSeek Latch Gateway — Current Plan

## Phase 1: Routing implementation
- [x] Provider/runtime configuration loader with environment interpolation.
- [x] Independent `routing.yaml` loader and endpoint-reference validation.
- [x] Hierarchical priority traversal with an inner latch per group.
- [x] Flash route: OpenCode Go Accounts 1/2/3, then Command Code fallback.
- [x] Pro route: shared Command Code provider with its namespaced upstream model.
- [x] Proxy retry, compatibility bridges, and route-level model mapping.
- [x] Unit and integration coverage for the three-key group and Priority 2 fallback.

## Phase 2: Local rollout
- [ ] Install the updated binary and `routing.yaml` on the Mac gateway.
- [ ] Verify `/healthz`, `/status`, Flash fallback, and Pro mapping.

## Phase 3: Fleet rollout
- [ ] Copy `OPENCODE_API_KEY_3` into each distinct fleet home secret file.
- [ ] Install the updated binary and route config on the gateway hosts.
- [ ] Restart and verify each gateway service independently.

`swear-review` is not modified or deployed by this project.
