import { afterEach, expect, it } from "bun:test";
import { Router } from "../src/router";
import type { GatewayConfig } from "../src/types";
import { mockUpstreams, ok, restoreFetch, send, status } from "./helpers";

afterEach(restoreFetch);

function config(baseUrl = "https://opencode.ai/zen/go/v1"): GatewayConfig {
  return {
    server: { host: "127.0.0.1", port: 0, timeoutSeconds: 10 },
    providers: Object.fromEntries([1, 2].map((n) => [`go-${n}`, {
      id: `go-${n}`, apiKey: "test", baseUrl, extraHeaders: { "X-OpenCode-Session": "static-config" },
    }])),
    models: { "deepseek-flash": [{ provider: "go-1", model: "m" }, { provider: "go-2", model: "m" }] },
  };
}

function sendTo(cfg: GatewayConfig, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return send(new Router(cfg), cfg, { model: "deepseek-flash", ...body }, headers);
}

function captureOpenCode(replies = [ok()]) {
  return mockUpstreams({ opencode: replies });
}

it("preserves the caller ID over provider config, including quota failover", async () => {
  const calls = captureOpenCode([status(429), ok()]);
  expect((await sendTo(config(), {}, { "x-opencode-session": "conversation-1", "x-session-id": "other" })).status).toBe(200);
  expect(calls.map((c) => c.headers.get("x-opencode-session"))).toEqual(["conversation-1", "conversation-1"]);
});

it("translates session headers supplied by DSH and Pi", async () => {
  const calls = captureOpenCode();
  for (const header of ["x-deepseek-harness-session-id", "x-session-id", "x-session-affinity", "session_id", "x-conversation-id", "conversation_id"]) {
    await sendTo(config(), {}, { [header]: "session-2" });
    expect(calls.at(-1)?.headers.get("x-opencode-session")).toBe("session-2");
  }
});

it("keeps opening-message affinity across turns and isolates different openings and client keys", async () => {
  const calls = captureOpenCode();
  const opening = { role: "user", content: [{ type: "text", text: "Review this" }] };
  await sendTo(config(), { messages: [opening] });
  await sendTo(config(), { messages: [opening, { role: "assistant", content: "OK" }, { role: "user", content: "Continue" }] });
  await sendTo(config(), { messages: [{ role: "user", content: "A different conversation" }] });
  await sendTo(config(), { messages: [opening] }, { authorization: "Bearer another-client" });
  const ids = calls.map((c) => c.headers.get("x-opencode-session"));
  expect(ids[0]).toMatch(/^[a-f0-9]{64}$/);
  expect(ids[0]).toBe(ids[1]);
  expect(new Set(ids).size).toBe(3);
});

it("rejects requests with neither identity nor opening and leaves other providers unchanged", async () => {
  const calls = mockUpstreams({ opencode: [ok()], api: [ok()] });
  expect((await sendTo(config(), {})).status).toBe(400);
  expect(calls).toHaveLength(0);
  const cfg = config("https://api.commandcode.ai/provider/v1");
  for (const p of Object.values(cfg.providers)) p.extraHeaders = {};
  expect((await sendTo(cfg, {})).status).toBe(200);
  expect(calls[0].headers.has("x-opencode-session")).toBe(false);
});

it("normalizes generic User-Agent headers like Python-urllib to aisimpv-gateway/1.0", async () => {
  const calls = captureOpenCode();
  await sendTo(config(), { input: "Hello" }, { "user-agent": "Python-urllib/3.14" });
  expect(calls.at(-1)?.headers.get("user-agent")).toBe("aisimpv-gateway/1.0");
  await sendTo(config(), { input: "Hello" });
  expect(calls.at(-1)?.headers.get("user-agent")).toBe("aisimpv-gateway/1.0");
  await sendTo(config(), { input: "Hello" }, { "user-agent": "custom-agent/2.0" });
  expect(calls.at(-1)?.headers.get("user-agent")).toBe("custom-agent/2.0");
});
