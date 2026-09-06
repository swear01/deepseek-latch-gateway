import { afterEach, expect, it, mock, spyOn } from "bun:test";
import { RSLatchManager } from "../src/latch";
import { PriorityLatchManager } from "../src/priority-latch";
import { handleProxyRequest } from "../src/proxy";
import type { GatewayConfig } from "../src/types";

const captured: Headers[] = [];
afterEach(() => { mock.restore(); captured.length = 0; });

function config(): GatewayConfig {
  return {
    server: { host: "127.0.0.1", port: 0, timeoutSeconds: 10 },
    strategy: { mode: "latch", debounceSeconds: 0, maxRetriesPerRequest: 2 },
    endpoints: [1, 2].map((n) => ({ id: `go-${n}`, name: `Go ${n}`, apiKey: "test",
      baseUrl: "https://opencode.ai/zen/go/v1", extraHeaders: { "X-OpenCode-Session": "static-config" } })),
  };
}

async function send(body: Record<string, unknown>, headers: Record<string, string> = {}, cfg = config(), priority = false) {
  const req = new Request("http://localhost/v1/chat/completions", {
    method: "POST", headers, body: JSON.stringify({ model: "deepseek-v4-flash", ...body }),
  });
  return handleProxyRequest({ req, url: new URL(req.url), config: cfg,
    latch: priority ? new PriorityLatchManager(cfg) : new RSLatchManager(cfg) });
}

function capture(failFirst = false) {
  const fakeFetch: typeof fetch = Object.assign(async (_url: RequestInfo | URL, init?: RequestInit) => {
    captured.push(new Headers(init?.headers));
    return Response.json({}, { status: failFirst && captured.length === 1 ? 429 : 200 });
  }, { preconnect: globalThis.fetch.preconnect });
  spyOn(globalThis, "fetch").mockImplementation(fakeFetch);
}

it("preserves the caller ID over endpoint config and aliases, including quota failover", async () => {
  capture(true);
  expect((await send({}, { "x-opencode-session": "conversation-1", "x-session-id": "other" })).status).toBe(200);
  expect(captured.map((h) => h.get("x-opencode-session"))).toEqual(["conversation-1", "conversation-1"]);
});

it("translates session headers supplied by DSH and Pi", async () => {
  capture();
  for (const header of ["x-deepseek-harness-session-id", "x-session-id", "x-session-affinity", "session_id"]) {
    await send({}, { [header]: "session-2" });
    expect(captured.at(-1)?.get("x-opencode-session")).toBe("session-2");
  }
});

it("keeps opening-message affinity across turns and isolates different openings and client keys", async () => {
  capture();
  const opening = { role: "user", content: [{ type: "text", text: "Review this" }] };
  await send({ messages: [opening] });
  await send({ messages: [opening, { role: "assistant", content: "OK" }, { role: "user", content: "Continue" }] });
  await send({ messages: [{ role: "user", content: "A different conversation" }] });
  await send({ messages: [opening] }, { authorization: "Bearer another-client" });
  const ids = captured.map((h) => h.get("x-opencode-session"));
  expect(ids[0]).toMatch(/^[a-f0-9]{64}$/);
  expect(ids[0]).toBe(ids[1]);
  expect(new Set(ids).size).toBe(3);
});

it("applies the same session ID on priority routing failover", async () => {
  capture(true);
  const cfg = config();
  cfg.routing = { routes: { "deepseek-v4-flash": { mode: "priority-latch", groups: [
    { id: "go", priority: 1, mode: "latch", members: cfg.endpoints.map((ep) => ({ endpointId: ep.id })) },
  ] } } };
  expect((await send({ input: "Hello" }, {}, cfg, true)).status).toBe(200);
  expect(captured).toHaveLength(2);
  expect(captured[0].get("x-opencode-session")).toBe(captured[1].get("x-opencode-session"));
});

it("rejects requests with neither identity nor opening and leaves other providers unchanged", async () => {
  capture();
  expect((await send({})).status).toBe(400);
  expect(captured).toHaveLength(0);
  const cfg = config();
  cfg.endpoints.forEach((ep) => { ep.baseUrl = "https://api.commandcode.ai/provider/v1"; ep.extraHeaders = {}; });
  expect((await send({}, {}, cfg)).status).toBe(200);
  expect(captured[0].has("x-opencode-session")).toBe(false);
});
