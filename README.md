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

---

## 🚀 Quick Start

### 1. Prerequisites
- [Bun](https://bun.sh) (v1.2+)

### 2. Setup Configuration
Copy `config.example.yaml` to `config.yaml`:
```bash
cp config.example.yaml config.yaml
```

Set your keys in your shell or `.env`:
```bash
export OPENCODE_GO_KEY_1="sk-opencode-go-account-1"
export OPENCODE_GO_KEY_2="sk-opencode-go-account-2"
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
      "apiKey": "local-gateway",
      "api": "openai-completions"
    }
  }
}
```

### 2. Python (DeepSeek Harness / OpenAI SDK)
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

### 3. Swear Review (`config.yaml`)
```yaml
llm:
  url: "http://127.0.0.1:35001/v1/chat/completions"
  model: "deepseek-v4-flash"
```

---

## 🛠️ Management & Monitoring Endpoints

* **Healthcheck**: `GET /healthz`
* **Realtime Metrics & Active Key**: `GET /status`
* **Manual Latch Toggle**: `POST /switch` or `POST /switch?index=1`

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
