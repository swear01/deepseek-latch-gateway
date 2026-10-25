import { afterEach, describe, expect, it } from "bun:test";
import { COOLDOWN_MS, Router } from "../src/router";
import { config, mockUpstreams, ok, provider, restoreFetch, send, status } from "./helpers";

afterEach(restoreFetch);

const chat = { model: "deepseek-flash", messages: [{ role: "user", content: "hi" }] };

function clock(start = 1_000_000) {
  const state = { now: start };
  return { state, now: () => state.now };
}

describe("ordered failover", () => {
  it("walks deployments in order, sending each one's model, and reports who answered", async () => {
    const cfg = config([provider("a"), provider("b"), provider("c")]);
    const calls = mockUpstreams({ a: [status(429)], b: [status(500)], c: [ok()] });
    const res = await send(new Router(cfg), cfg, chat);
    expect(res.status).toBe(200);
    expect(calls.map((c) => c.body.model)).toEqual(["a-flash", "b-flash", "c-flash"]);
    expect(res.headers.get("X-Gateway-Active-Endpoint")).toBe("c");
    expect(res.headers.get("X-Gateway-Upstream-Model")).toBe("c-flash");
    expect(res.headers.get("X-Gateway-Attempt")).toBe("3");
  });

  it("does not contact a failed deployment for 30 minutes, then tries it again", async () => {
    const cfg = config([provider("a"), provider("b")]);
    const time = clock();
    const router = new Router(cfg, time.now);
    const calls = mockUpstreams({ a: [status(429), ok()], b: [ok()] });

    await send(router, cfg, chat);
    time.state.now += COOLDOWN_MS - 1;
    await send(router, cfg, chat);
    expect(calls.map((c) => new URL(c.url).hostname)).toEqual(["a.test", "b.test", "b.test"]);

    time.state.now += 1;
    const res = await send(router, cfg, chat);
    expect(res.headers.get("X-Gateway-Active-Endpoint")).toBe("a");
  });

  for (const [title, reply] of [
    ["quota 429", status(429)],
    ["payment 402", status(402)],
    ["revoked key 401", status(401)],
    ["OpenCode credits 401", status(401, { type: "error", error: { type: "CreditsError", message: "Insufficient balance" } })],
    ["inactive subscription 403", status(403, { error: { message: "An active OpenCode Go subscription is required to use Go models." } })],
    ["Cloudflare 1010 403", status(403, "<html>Error 1010 Ray ID: 1 Access denied</html>")],
    ["upstream 503", status(503)],
    ["timeout 408", status(408)],
  ] as const) {
    it(`cools down a deployment on ${title}`, async () => {
      const cfg = config([provider("a"), provider("b")]);
      const router = new Router(cfg);
      mockUpstreams({ a: [reply], b: [ok()] });
      expect((await send(router, cfg, chat)).headers.get("X-Gateway-Active-Endpoint")).toBe("b");
      expect(router.available("deepseek-flash").map((d) => d.provider)).toEqual(["b"]);
    });
  }

  it("retries a single network failure on the same provider without cooling it down", async () => {
    const cfg = config([provider("a"), provider("b")]);
    const router = new Router(cfg);
    const calls = mockUpstreams({ a: [new Error("connection reset"), ok()], b: [ok()] });
    expect((await send(router, cfg, chat)).headers.get("X-Gateway-Active-Endpoint")).toBe("a");
    expect(calls).toHaveLength(2);
    expect(router.available("deepseek-flash")).toHaveLength(2);
  });

  it("cools down a provider that fails the network retry too", async () => {
    const cfg = config([provider("a"), provider("b")]);
    const router = new Router(cfg);
    mockUpstreams({ a: [new Error("connection refused")], b: [ok()] });
    expect((await send(router, cfg, chat)).headers.get("X-Gateway-Active-Endpoint")).toBe("b");
    expect(router.available("deepseek-flash").map((d) => d.provider)).toEqual(["b"]);
  });

  for (const [title, reply] of [
    ["400 bad request", status(400, { error: { message: "context too long" } })],
    ["ordinary 403", status(403, { error: { message: "permission denied" } })],
    ["404", status(404)],
  ] as const) {
    it(`relays a client-side ${title} without failover or cooldown`, async () => {
      const cfg = config([provider("a"), provider("b")]);
      const router = new Router(cfg);
      const calls = mockUpstreams({ a: [reply], b: [ok()] });
      const res = await send(router, cfg, chat);
      expect(res.status).toBe(reply.status);
      expect(calls).toHaveLength(1);
      expect(router.available("deepseek-flash")).toHaveLength(2);
    });
  }

  it("answers 503 with Retry-After and no upstream call while every deployment cools down", async () => {
    const cfg = config([provider("a"), provider("b")]);
    const time = clock();
    const router = new Router(cfg, time.now);
    const calls = mockUpstreams({ a: [status(429)], b: [new Error("down")] });
    const first = await send(router, cfg, chat);
    expect(first.status).toBe(503);
    expect((await first.json()).error.code).toBe("no_available_provider");
    expect(calls).toHaveLength(3);

    const second = await send(router, cfg, chat);
    expect(second.status).toBe(503);
    expect(Number(second.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(calls).toHaveLength(3);
  });

  it("keeps cooldowns per model, so one model's failure does not block another on the same provider", async () => {
    const cfg = config([provider("a")], {
      "deepseek-flash": [{ provider: "a", model: "flash" }],
      "deepseek-pro": [{ provider: "a", model: "pro" }],
    });
    const router = new Router(cfg);
    mockUpstreams({ a: [(call) => (call.body.model === "flash" ? status(429) : ok())] });
    expect((await send(router, cfg, chat)).status).toBe(503);
    expect((await send(router, cfg, { ...chat, model: "deepseek-pro" })).status).toBe(200);
  });

  it("does not cool down a provider when the client disconnects", async () => {
    const cfg = config([provider("a"), provider("b")]);
    const router = new Router(cfg);
    const controller = new AbortController();
    mockUpstreams({ a: [() => { controller.abort(); return new Error("aborted"); }], b: [ok()] });
    await expect(send(router, cfg, chat, {}, { signal: controller.signal })).rejects.toThrow();
    expect(router.available("deepseek-flash")).toHaveLength(2);
  });

  it("fails over when an upstream error body cannot be read", async () => {
    const cfg = config([provider("a"), provider("b")]);
    const router = new Router(cfg);
    const broken = () => new Response(new ReadableStream({ pull(c) { c.error(new Error("reset mid-body")); } }), { status: 502 });
    mockUpstreams({ a: [broken], b: [ok()] });
    expect((await send(router, cfg, chat)).headers.get("X-Gateway-Active-Endpoint")).toBe("b");
    expect(router.available("deepseek-flash").map((d) => d.provider)).toEqual(["b"]);
  });

  it("skips OpenCode deployments without a session id instead of rejecting the request", async () => {
    const cfg = config([provider("go", { baseUrl: "https://opencode.ai/zen/go/v1" }), provider("cc")]);
    const router = new Router(cfg);
    const calls = mockUpstreams({ opencode: [ok()], cc: [ok()] });
    const res = await send(router, cfg, { model: "deepseek-flash" });
    expect(res.headers.get("X-Gateway-Active-Endpoint")).toBe("cc");
    expect(calls.map((c) => new URL(c.url).hostname)).toEqual(["cc.test"]);
    expect(router.available("deepseek-flash")).toHaveLength(2);
  });
});

describe("request validation", () => {
  it("rejects model ids that are not configured and are not DeepSeek aliases", async () => {
    const cfg = config([provider("a")]);
    const calls = mockUpstreams({ a: [ok()] });
    for (const model of ["gpt-5", "deepseek-pro", "deepseek/deepseek-v4-flash-vision-exp", "deepseek-v4.1-flash-fast"]) {
      const res = await send(new Router(cfg), cfg, { ...chat, model });
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("model_not_allowed");
    }
    expect(calls).toHaveLength(0);
  });

  it("routes versioned, dated and prefixed DeepSeek names to the unversioned model", async () => {
    const cfg = config([provider("a")], {
      "deepseek-flash": [{ provider: "a", model: "flash" }],
      "deepseek-pro": [{ provider: "a", model: "pro" }],
    });
    const calls = mockUpstreams({ a: [ok()] });
    const names = [
      "deepseek-v4-flash", "deepseek-v4.1-flash-1017", "deepseek/deepseek-v4.1-flash", "opencode-go/deepseek-flash",
      "~deepseek/deepseek-flash-latest", "deepseek-v4-pro", "deepseek/deepseek-v4-pro-0813",
    ];
    for (const model of names) expect((await send(new Router(cfg), cfg, { ...chat, model })).status).toBe(200);
    expect(calls.map((c) => c.body.model)).toEqual(["flash", "flash", "flash", "flash", "flash", "pro", "pro"]);
  });

  it("rejects bodies without a model", async () => {
    const cfg = config([provider("a")]);
    mockUpstreams({ a: [ok()] });
    for (const body of ["not json", "null", JSON.stringify({ messages: [] })]) {
      const res = await send(new Router(cfg), cfg, body);
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("missing_model");
    }
  });

  it("lists the configured public models", async () => {
    const cfg = config([provider("a")], { "deepseek-flash": [{ provider: "a", model: "x" }], "deepseek-pro": [{ provider: "a", model: "y" }] });
    const res = await send(new Router(cfg), cfg, "", {}, { method: "GET", path: "/v1/models" });
    expect((await res.json()).data.map((m: { id: string }) => m.id)).toEqual(["deepseek-flash", "deepseek-pro"]);
  });

  it("rejects response_format json_schema without touching an upstream", async () => {
    const cfg = config([provider("a")]);
    const calls = mockUpstreams({ a: [ok()] });
    const res = await send(new Router(cfg), cfg, { ...chat, response_format: { type: "json_schema", json_schema: {} } });
    expect(res.status).toBe(400);
    expect((await res.json()).error.param).toBe("response_format");
    expect(calls).toHaveLength(0);
  });
});

describe("provider compat", () => {
  it("strips response_format (including null) only for providers that declare it", async () => {
    const cfg = config([provider("a", { compat: { stripResponseFormat: true } }), provider("b")], {
      "deepseek-flash": [{ provider: "a", model: "m" }],
      "deepseek-pro": [{ provider: "b", model: "m" }],
    });
    const calls = mockUpstreams({ a: [ok()], b: [ok()] });
    await send(new Router(cfg), cfg, { ...chat, response_format: { type: "json_object" } });
    await send(new Router(cfg), cfg, { ...chat, response_format: null });
    await send(new Router(cfg), cfg, { ...chat, model: "deepseek-pro", response_format: { type: "json_object" } });
    expect(calls.map((c) => "response_format" in c.body)).toEqual([false, false, true]);
  });

  it("merges extra_body but never lets it override model or response_format", async () => {
    const cfg = config([provider("a", { extraBody: { model: "wrong", response_format: { type: "text" }, provider: { sort: "throughput" } } })]);
    const calls = mockUpstreams({ a: [ok()] });
    await send(new Router(cfg), cfg, { ...chat, response_format: { type: "json_object" } });
    expect(calls[0].body).toMatchObject({ model: "a-flash", response_format: { type: "json_object" }, provider: { sort: "throughput" } });
  });

  it("renames a non-official reasoning field in JSON responses", async () => {
    const cfg = config([provider("a", { compat: { responseReasoningField: "reasoning" } })]);
    mockUpstreams({ a: [ok({ choices: [{ message: { content: "x", reasoning: "r", reasoning_details: [] } }] })] });
    const body = await (await send(new Router(cfg), cfg, chat)).json();
    expect(body.choices[0].message).toEqual({ content: "x", reasoning_content: "r" });
  });

  it("renames reasoning fields in SSE deltas and preserves [DONE]", async () => {
    const cfg = config([provider("a", { compat: { responseReasoningField: "reasoning" } })]);
    const sse = 'data: {"choices":[{"delta":{"reasoning":"T","reasoning_details":[]}}]}\n\ndata: [DONE]\n\n';
    mockUpstreams({ a: [new Response(sse, { headers: { "Content-Type": "text/event-stream" } })] });
    const text = await (await send(new Router(cfg), cfg, { ...chat, stream: true })).text();
    expect(text).toBe('data: {"choices":[{"delta":{"reasoning_content":"T"}}]}\n\ndata: [DONE]\n\n');
  });

  it("unwraps double-wrapped errors and forwards other errors verbatim", async () => {
    const cfg = config([provider("a", { compat: { unwrapError: true } })]);
    const inner = { error: { message: "Invalid input", type: "invalid_request_error", param: "response_format" } };
    mockUpstreams({ a: [status(400, { error: { message: JSON.stringify(inner) } }), status(400, { error: { message: "plain" } })] });
    expect(await (await send(new Router(cfg), cfg, chat)).json()).toEqual(inner);
    expect(await (await send(new Router(cfg), cfg, chat)).json()).toEqual({ error: { message: "plain" } });
  });
});
