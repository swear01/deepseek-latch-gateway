# DeepSeek Latch Gateway

A high-performance, ultra-lightweight AI Gateway tailored for **DeepSeek series models** and **OpenCode Go multi-account subscriptions**.

Features a stateful **RS-Latch (Bistable Sticky Failover)** mechanism that completely eliminates rate-limit probing penalties and delivers seamless, zero-interruption in-session key rotation.

---

## ⚡ Core Mechanism: RS-Latch State Machine

Unlike stateless generic proxies (which alternate every request or rely on fixed cooldown timers), **DeepSeek Latch Gateway** maintains a sticky active key state:

1. **Sticky State**: All requests stick to **Key 1** as long as it returns `200 OK`.
2. **Latch Flip on 429**: When Key 1 hits `429 Too Many Requests` or Quota Limits:
   - The latch flips to **Key 2**.
   - The current in-flight request is immediately and transparently retried with Key 2.
   - **All subsequent requests permanently stick to Key 2**.
3. **Cycle on Exhaustion**: When Key 2 eventually hits 429, the latch flips back to **Key 1** (or Key 3 if multi-key is configured).
4. **Debounced Concurrency**: Simultaneous 429s within a 1-second window do not double-increment the latch.

### Retry & Failover Semantics

- **`max_retries_per_request`** is the number of *pool endpoint attempts* per in-flight request. Each endpoint attempt includes one **free same-endpoint retry** for transient network failures (a socket hiccup is retried on the same key; the latch never flips on a single transient failure). Worst case upstream calls per request: `2 × max_retries_per_request`.
- A key that fails twice with **network errors** in one request is skipped for the rest of that request and the latch advances away from it (debounced) — but network failures are **never counted as 429/quota** in `/status` stats.
- **`X-Gateway-Attempt`** response header: cumulative number of upstream fetch calls made for the request (includes the free same-endpoint retries).

---

## 🧭 Model-Based Dedicated Routing

An endpoint declaring a `models` list becomes a **dedicated route**: incoming requests whose `model` matches are forwarded directly to that endpoint, **bypassing the RS-Latch pool entirely**. All other models flow through the latch pool as usual.

Optional `model_map` rewrites the outgoing model name per endpoint (e.g. Command Code uses a `deepseek/`-namespaced catalog):

```yaml
endpoints:
  - id: "command-code"
    name: "Command Code (V4 Pro)"
    base_url: "https://api.commandcode.ai/provider/v1"
    api_key: "${COMMAMD_CODE_API_KEY}"
    models: ["deepseek-v4-pro"]              # incoming model -> dedicated route
    model_map:
      "deepseek-v4-pro": "deepseek/deepseek-v4-pro"   # outgoing rename

  - id: "opencode-go-1"
    name: "OpenCode Go (Account 1)"
    base_url: "https://opencode.ai/zen/go/v1"
    api_key: "${OPENCODE_API_KEY_1}"        # no models -> latch pool member
```

Dedicated endpoint traffic is still visible in `/status` (requests / success / 429 counters).

---

## 🚀 Quick Start

### 1. Prerequisites
- [Bun](https://bun.sh) (v1.2+)

### 2. Setup Configuration
Copy `config.example.yaml` to `config.yaml`:
```bash
cp config.example.yaml config.yaml
```

Set your keys in your shell or `~/.secrets`:
```bash
export OPENCODE_API_KEY_1="sk-opencode-account-1"
export OPENCODE_API_KEY_2="sk-opencode-account-2"
export COMMAMD_CODE_API_KEY="sk-command-code"   # optional: V4 Pro dedicated route
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
* **Realtime Metrics & Active Key**: `GET http://127.0.0.1:35001/status`
* **Manual Latch Toggle**: `POST http://127.0.0.1:35001/switch` or `POST http://127.0.0.1:35001/switch?index=1`

---

## 🖥️ Fleet Deployment & Service Management

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
