# DeepSeek Latch Gateway

A small OpenAI-compatible gateway for **DeepSeek models** across OpenCode Go
accounts, Command Code and OpenRouter. Clients ask for `deepseek-flash` or
`deepseek-pro`; the gateway tries that model's upstreams in order and always
targets each provider's newest DeepSeek model.

The configuration follows LiteLLM's shape (one public model name, an ordered
list of deployments, cooldown on failure), implemented as a single Bun binary.

---

## Configuration

One file, `config.yaml`:

```yaml
providers:
  opencode-go-1: { base_url: "https://opencode.ai/zen/go/v1", api_key: "${OPENCODE_API_KEY_1}", compat: { strip_response_format: true } }
  command-code:  { base_url: "https://api.commandcode.ai/provider/v1", api_key: "${COMMAND_CODE_API_KEY}", compat: { ... } }
  openrouter:    { base_url: "https://openrouter.ai/api/v1", api_key: "${OPENROUTER_API_KEY}", extra_body: { provider: { ... } } }

models:
  deepseek-flash:
    - { provider: opencode-go-1, model: "deepseek-v4.1-flash" }
    - { provider: command-code, model: "deepseek/deepseek-v4.1-flash" }
    - { provider: openrouter, model: "~deepseek/deepseek-flash-latest" }
```

See `config.example.yaml` for the full fleet configuration. The keys of
`models` are the only model ids the gateway accepts; anything else gets
400 `model_not_allowed`.

## Routing and cooldown

- Each request uses the first deployment of its model that is not cooling
  down, so later deployments stay untouched while an earlier one works.
- A deployment that fails is skipped for **30 minutes**, then tried again by
  the next request. Failures are: 429/402 and quota messages (including
  OpenCode `CreditsError` 401 and the inactive-subscription 403), any other
  401, Cloudflare 1010 403, 408, 5xx, and network errors. A network error is
  retried once on the same provider before it counts.
- Other 4xx responses (bad request, ordinary 403, 404) describe the client's
  request and are returned unchanged without a cooldown. A client disconnect
  never cools down a provider.
- Cooldown is per deployment (provider + model): a failure for one model does
  not block the same provider for another model.
- If every deployment of a model fails or is cooling down, the client gets
  503 `no_available_provider` with `Retry-After`.
- Responses carry `X-Gateway-Active-Endpoint` (provider id),
  `X-Gateway-Upstream-Model` (model name sent upstream) and
  `X-Gateway-Attempt` (upstream fetch calls). The body's `model` field is what
  the upstream reports it served.

## Always the newest DeepSeek

Deployments never name a dated snapshot. OpenCode Go and Command Code only
list undated names; OpenRouter's `~deepseek/deepseek-flash-latest` and
`~deepseek/deepseek-pro-latest` follow DeepSeek's newest release.
`bun test` rejects a pinned snapshot in `config.example.yaml`, and

```bash
bun run check-latest ~/.config/deepseek-gateway/config.yaml
```

checks a live config: every undated deployment must be the highest version in
its provider's `/models` list, and each OpenRouter alias must serve the newest
snapshot OpenRouter lists. It exits non-zero on any mismatch, so a new DeepSeek
release that a provider has not picked up yet is reported.

## OpenCode session headers

For POST requests to `opencode.ai`, the gateway preserves the caller's
`x-opencode-session`. When absent, it uses the first nonempty header from
`x-deepseek-harness-session-id`, `x-session-id`, `x-session-affinity`,
`x-conversation-id`, `session_id` and `conversation_id`. Provider-level static
headers cannot override this identity.

Clients without an ID receive a SHA-256 affinity key derived from the opening
user message and client identity (incoming Authorization, DSH user ID, and body
`user`). Chat messages, Responses `input`, and completion `prompt` are supported.
The key remains stable when later turns are appended, including retries and
provider failover. Only the hash is sent; this feature does not store prompts.

This fallback is a heuristic: identical openings for the same client share an
affinity key, and truncating or replacing the opening during compaction changes
it. Send an explicit session header for exact conversation isolation. A request
with neither an ID nor an opening skips the OpenCode deployments (without a
cooldown) and goes to the model's other deployments; if only OpenCode is
configured it receives HTTP 400 `missing_session_id`. Other providers keep their
existing header behavior.

## 🎯 DeepSeek Official Contract First (統一正規化)

**Clients always speak the DeepSeek official API contract; the gateway bridges
provider differences automatically.** No client needs per-endpoint workarounds
(e.g. disabling JSON mode in a harness), because every provider's declared
`compat` deviations are normalized at the proxy layer:

| Normalization | What happens | When |
|---|---|---|
| `strip_response_format` | `response_format` removed from the upstream request | upstream 400s on it (Command Code, OpenCode Go) |
| `response_reasoning_field` | upstream reasoning field renamed to `reasoning_content` (non-streaming `message` **and** SSE `delta`), companion `*_details` field dropped | upstream uses `reasoning`/`reasoning_details` (Command Code) |
| `unwrap_error` | double-wrapped `{"error":{"message":"<JSON>"}}` error bodies unwrapped to the official single-layer shape | upstream wraps errors twice (Command Code) |
| `json_schema` rejection | `response_format.type != "json_object"` → official-style 400 `invalid_request_error` at the router, no upstream call | always (official chat completions only support `json_object`) |

A provider without `compat` is a **full passthrough** — e.g. DeepSeek official:

```yaml
providers:
  command-code:
    base_url: "https://api.commandcode.ai/provider/v1"
    compat:
      strip_response_format: true
      response_reasoning_field: "reasoning"
      unwrap_error: true

  deepseek-official:
    base_url: "https://api.deepseek.com/v1"
    # no compat: complete official passthrough
```

SSE streams are rewritten line-by-line through a `TransformStream` only when a
provider declares `response_reasoning_field`; `data: [DONE]` and the event
framing are untouched, and any line that fails to parse is forwarded verbatim
so a conversion error can never break a stream. Providers without compat keep
zero-copy streaming.

---

## 🚀 Quick Start

### 1. Prerequisites
- [Bun](https://bun.sh) (v1.2+)

### 2. Setup Configuration
Copy the configuration template:
```bash
cp config.example.yaml config.yaml
```

Set your keys in your shell or `~/.secrets`:
```bash
export OPENCODE_API_KEY_1="sk-opencode-account-1"
export OPENCODE_API_KEY_2="sk-opencode-account-2"
export OPENCODE_API_KEY_3="sk-opencode-account-3"
export COMMAND_CODE_API_KEY="sk-command-code"
export OPENROUTER_API_KEY="sk-or-v1-openrouter"
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
    model="deepseek-flash",
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
  model: "deepseek-flash"
```

---

## 🛠️ Management & Monitoring Endpoints

* **Healthcheck**: `GET http://127.0.0.1:35001/healthz`
* **Per-deployment requests, failures and cooldowns**: `GET http://127.0.0.1:35001/status`
* **Model list**: `GET http://127.0.0.1:35001/v1/models`

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
bun run check-latest config.yaml   # live: needs the provider keys
```

---

## 📄 License
MIT License
