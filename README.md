# DeepSeek Latch Gateway

A high-performance, ultra-lightweight AI Gateway tailored for **DeepSeek series models** and **OpenCode Go multi-account subscriptions**.

Features a stateful **RS-Latch (Bistable Sticky Failover)** mechanism that completely eliminates rate-limit probing penalties and delivers seamless, zero-interruption in-session key rotation.

---

## ⚡ Core Mechanism: Hierarchical Priority Latch

The gateway uses an outer priority chain and an independent RS-Latch inside each priority group:

```text
Priority 1: OpenCode Go latch
  Account 1 → Account 2 → Account 3

Priority 2: Command Code latch
  Command Code (last fallback)
```

1. Requests stay on the active OpenCode account while it succeeds.
2. A quota response advances within the Priority 1 OpenCode latch.
3. Only after all three OpenCode accounts are exhausted does the request enter Priority 2.
4. Command Code uses the same provider definition for Flash fallback and Pro routing.
5. The outer latch does not immediately cycle back to an exhausted higher-priority group.

### Retry & Failover Semantics

- `max_retries_per_request` bounds endpoint attempts across the selected route. Each endpoint attempt includes one same-endpoint retry for transient network failures.
- A definitive quota response advances the current group; two network failures skip that endpoint for the current request without counting as a 429.
- `X-Gateway-Attempt` reports cumulative upstream fetch calls, including same-endpoint retries.

---

## 🧭 Routing Is Separate From Providers

`config.yaml` contains provider/runtime settings only: URLs, environment-variable
references, compatibility bridges, and the model allowlist. `routing.yaml`
contains model priority, group mode, endpoint order, and route-specific upstream
model names.

```yaml
routes:
  deepseek-v4-flash:
    mode: "priority-latch"
    priority_groups:
      - id: "opencode-go"
        priority: 1
        mode: "latch"
        members:
          - endpoint: "opencode-go-1"
          - endpoint: "opencode-go-2"
          - endpoint: "opencode-go-3"
      - id: "command-code-fallback"
        priority: 2
        mode: "latch"
        members:
          - endpoint: "command-code"
            upstream_model: "deepseek/deepseek-v4-flash"
```

The same `command-code` provider can be referenced by the Pro route with a
different `upstream_model`; it is not duplicated in the provider list.

---

## 🎯 DeepSeek Official Contract First (統一正規化)

**Clients always speak the DeepSeek official API contract; the gateway bridges
endpoint differences automatically.** No client needs per-endpoint workarounds
(e.g. disabling JSON mode in a harness), because every endpoint's declared
`compat` deviations are normalized at the proxy layer:

| Normalization | What happens | When |
|---|---|---|
| `strip_response_format` | `response_format` removed from the upstream request | upstream 400s on it (Command Code, OpenCode Go) |
| `response_reasoning_field` | upstream reasoning field renamed to `reasoning_content` (non-streaming `message` **and** SSE `delta`), companion `*_details` field dropped | upstream uses `reasoning`/`reasoning_details` (Command Code) |
| `unwrap_error` | double-wrapped `{"error":{"message":"<JSON>"}}` error bodies unwrapped to the official single-layer shape | upstream wraps errors twice (Command Code) |
| `json_schema` rejection | `response_format.type != "json_object"` → official-style 400 `invalid_request_error` at the router, no upstream call | always (official chat completions only support `json_object`) |

An endpoint without `compat` is a **full passthrough** — e.g. DeepSeek official:

```yaml
endpoints:
  - id: "command-code"
    base_url: "https://api.commandcode.ai/provider/v1"
    compat:
      strip_response_format: true
      response_reasoning_field: "reasoning"
      unwrap_error: true

  - id: "deepseek-official"
    base_url: "https://api.deepseek.com/v1"
    # no compat: complete official passthrough
```

SSE streams are rewritten line-by-line through a `TransformStream` only when an
endpoint declares `response_reasoning_field`; `data: [DONE]` and the event
framing are untouched, and any line that fails to parse is forwarded verbatim
so a conversion error can never break a stream. Endpoints without compat keep
zero-copy streaming.

---

## 🚀 Quick Start

### 1. Prerequisites
- [Bun](https://bun.sh) (v1.2+)

### 2. Setup Configuration
Copy both configuration templates:
```bash
cp config.example.yaml config.yaml
cp routing.example.yaml routing.yaml
```

Set your keys in your shell or `~/.secrets`:
```bash
export OPENCODE_API_KEY_1="sk-opencode-account-1"
export OPENCODE_API_KEY_2="sk-opencode-account-2"
export OPENCODE_API_KEY_3="sk-opencode-account-3"
export COMMAMD_CODE_API_KEY="sk-command-code"
```

### 3. Run Gateway
```bash
bun start
# or development with hot reload:
bun dev
```

---

## 📦 Client Integrations

### 1. Pi Agent (`~/.pi/agent/models.json`)
```json
{
  "providers": {
    "opencode-go": {
      "baseUrl": "http://127.0.0.1:35001/v1",
      "apiKey": "local-gateway"
    }
  }
}
```

### 2. DeepSeek Harness (`~/.dsh/settings.yaml` or `cordis.patch.yml`)
```yaml
llm-deepseek:
  baseURL: http://127.0.0.1:35001/v1
  apiKeyEnv: OPENCODE_API_KEY_1
```

### 3. Python (OpenAI SDK)
```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:35001/v1",
    api_key="local-gateway"
)

response = client.chat.completions.create(
    model="deepseek-v4-flash",
    messages=[{"role": "user", "content": "Hello!"}],
    stream=True
)
for chunk in response:
    print(chunk.choices[0].delta.content or "", end="")
```

### 4. Swear Review (Oracle `/opt/swear-review/data/config.yaml`)
```yaml
llm:
  url: "http://127.0.0.1:35001/v1/chat/completions"
  model: "deepseek-v4-flash"
```

---

## 🛠️ Management & Monitoring Endpoints

* **Healthcheck**: `GET http://127.0.0.1:35001/healthz`
* **Realtime Metrics, Active Group & Key**: `GET http://127.0.0.1:35001/status`
* **Manual Latch Toggle**: `POST http://127.0.0.1:35001/switch` or `POST http://127.0.0.1:35001/switch?index=1`

---

## 🖥️ Fleet Deployment & Service Management

> 完整 rollout 程序（build → 部署 → 驗證 → dsh credentials 同步）見
> **[`docs/deployment.md`](docs/deployment.md)**。改版後務必照 checklist 執行。

### Fleet endpoint matrix（每台機器接到的 endpoint）

所有 client（pi models.json / opencode.jsonc / swear-review）一律指向**本機**的 gateway，無跨機連線：

| 機器 | Gateway port | 備註 |
|---|---|---|
| Mac | `127.0.0.1:35001` | opencode.jsonc 為 symlink → `transfer_MAC/stow` |
| mazu / athena / cthulhu / valkyrie | `127.0.0.1:35001` | NFS 共享 home，寫一次全同步 |
| oracle | `127.0.0.1:35001` | 另有 swear-review → `localhost:35001` |
| zeus（`su_zeus`/swear02） | `127.0.0.1:35002` | 同機還有 swear01 帳號，loopback port 整機共享，35001 會 EADDRINUSE；zeus 的 opencode 走直接 OAuth，不經 gateway |

> **zeus special case**: the zeus machine (`140.112.171.138`, lab server) hosts
> both `swear02` (zeus) and `swear01` accounts. Loopback ports are shared
> machine-wide, so the `swear01` gateway (NFS-shared config) and the `swear02`
> gateway cannot both bind `35001` (`EADDRINUSE`, observed 2026-08-16).
> `su_zeus` therefore runs on port **35002** (`~/.config/deepseek-gateway/config.yaml`,
> `~/.pi/agent/models.json` adjusted accordingly). All other machines use `35001`.

### macOS (LaunchAgent)
- **Plist**: `~/Library/LaunchAgents/com.swear.deepseek-gateway.plist`
- **Config**: `~/.config/deepseek-gateway/config.yaml`
- **Commands**:
  ```bash
  launchctl load ~/Library/LaunchAgents/com.swear.deepseek-gateway.plist   # 啟動
  launchctl unload ~/Library/LaunchAgents/com.swear.deepseek-gateway.plist # 停止
  tail -f ~/.local/log/deepseek-gateway.log
  ```

### Linux / Oracle Cloud (Systemd User Unit)
- **Service**: `~/.config/systemd/user/deepseek-gateway.service`
- **Config**: `~/.config/deepseek-gateway/config.yaml`
- **Commands**:
  ```bash
  systemctl --user status deepseek-gateway
  systemctl --user restart deepseek-gateway
  tail -f ~/.local/log/deepseek-gateway.log
  ```

---

## 🧪 Testing & Verification

```bash
bun test
bun run typecheck
bun run build
```

---

## 📄 License
MIT License
