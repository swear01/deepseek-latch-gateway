import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { RSLatchManager } from "../src/latch";
import { handleProxyRequest } from "../src/proxy";
import type { EndpointConfig, GatewayConfig } from "../src/types";

let mockServer1: ReturnType<typeof Bun.serve>;
let mockServer2: ReturnType<typeof Bun.serve>;
let mockServer3: ReturnType<typeof Bun.serve>;
let mockServer4: ReturnType<typeof Bun.serve>;
let server1Hits = 0;
let server2Hits = 0;
let server3Hits = 0;
let server3ReceivedModel = "";
let server4Hits = 0;
let server4ReceivedBody: Record<string, unknown> | null = null;
type Server4Mode = "echo" | "rename" | "double-error" | "plain-error" | "rename-sse";
let server4Mode: Server4Mode = "echo";

beforeAll(() => {
  // Mock Upstream 1: Returns 429 Rate Limit
  mockServer1 = Bun.serve({
    port: 19001,
    fetch(req) {
      server1Hits++;
      const auth = req.headers.get("Authorization");
      return new Response(
        JSON.stringify({
          error: {
            message: "Rate limit exceeded on Account 1 (429)",
            type: "insufficient_quota",
            code: 429,
          },
          received_auth: auth,
        }),
        {
          status: 429,
          headers: { "Content-Type": "application/json" },
        }
      );
    },
  });

  // Mock Upstream 2: Returns 200 OK SSE Stream with DeepSeek reasoning_content
  mockServer2 = Bun.serve({
    port: 19002,
    fetch(req) {
      server2Hits++;
      const auth = req.headers.get("Authorization");
      const sseStream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              `data: {"choices":[{"delta":{"reasoning_content":"Thinking steps..."}}]}\n\n`
            )
          );
          controller.enqueue(
            new TextEncoder().encode(
              `data: {"choices":[{"delta":{"content":"DeepSeek answer text."}}]}\n\n`
            )
          );
          controller.enqueue(new TextEncoder().encode(`data: [DONE]\n\n`));
          controller.close();
        },
      });

      return new Response(sseStream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "X-Mock-Auth": auth || "",
        },
      });
    },
  });
  // Mock Upstream 3: Dedicated route (echoes received model)
  mockServer3 = Bun.serve({
    port: 19003,
    async fetch(req) {
      server3Hits++;
      const body = await req.json();
      server3ReceivedModel = body.model;
      return Response.json({
        choices: [{ message: { role: "assistant", content: "Dedicated V4 Pro answer." } }],
        received_model: body.model,
      });
    },
  });
  // Mock Upstream 4: Dedicated route with switchable compat behaviors
  mockServer4 = Bun.serve({
    port: 19004,
    async fetch(req) {
      server4Hits++;
      const body = await req.json();
      server4ReceivedBody = body;
      switch (server4Mode) {
        case "rename":
          return Response.json({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "{\"answer\":42}",
                  reasoning: "Hidden chain of thought.",
                  reasoning_details: [{ type: "reasoning.text", text: "Hidden chain of thought." }],
                },
              },
            ],
          });
        case "double-error":
          return new Response(
            JSON.stringify({
              error: {
                message: JSON.stringify({
                  error: {
                    message: "Invalid input",
                    type: "invalid_request_error",
                    param: "response_format",
                    code: "invalid_request_error",
                  },
                }),
                type: "invalid_request_error",
              },
            }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        case "plain-error":
          return new Response(
            JSON.stringify({ error: { message: "not json inside at all", type: "invalid_request_error" } }),
            { status: 400, headers: { "Content-Type": "application/json" } }
          );
        case "rename-sse":
          return new Response(
            new ReadableStream({
              start(controller) {
                const enc = new TextEncoder();
                controller.enqueue(
                  enc.encode(
                    `data: {"choices":[{"delta":{"reasoning":"Think","reasoning_details":[{"type":"reasoning.text","text":"Think"}]}}]}\n\n`
                  )
                );
                controller.enqueue(
                  enc.encode(`data: {"choices":[{"delta":{"content":"{\"answer\":42}"}}]}\n\n`)
                );
                controller.enqueue(enc.encode(`data: [DONE]\n\n`));
                controller.close();
              },
            }),
            { status: 200, headers: { "Content-Type": "text/event-stream" } }
          );
        default:
          return Response.json({
            choices: [{ message: { role: "assistant", content: "Echo answer." } }],
          });
      }
    },
  });
});

afterAll(() => {
  mockServer1.stop();
  mockServer2.stop();
  mockServer3.stop();
  mockServer4.stop();
});

function compatTestConfig(compat: EndpointConfig["compat"]): GatewayConfig {
  return {
    server: { host: "127.0.0.1", port: 8080, timeoutSeconds: 10 },
    strategy: { mode: "latch", debounceSeconds: 0.01, maxRetriesPerRequest: 2 },
    endpoints: [
      {
        id: "dedicated-compat",
        name: "Compat Upstream",
        baseUrl: "http://127.0.0.1:19004/v1",
        apiKey: "sk-compat",
        models: ["deepseek-v4-pro"],
        modelMap: { "deepseek-v4-pro": "deepseek/deepseek-v4-pro" },
        compat,
      },
      {
        id: "ep-pool",
        name: "Pool Member",
        baseUrl: "http://127.0.0.1:19002/v1",
        apiKey: "sk-pool",
      },
    ],
    models: { aliases: {} },
  };
}

function postChat(latch: RSLatchManager, config: GatewayConfig, body: Record<string, unknown>) {
  const req = new Request("http://127.0.0.1:8080/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return handleProxyRequest({ req, url: new URL(req.url), latch, config });
}

describe("Proxy & Failover Integration", () => {
  it("automatically fails over from Key 1 (429) to Key 2 (200) in a single request", async () => {
    const config: GatewayConfig = {
      server: { host: "127.0.0.1", port: 8080, timeoutSeconds: 10 },
      strategy: { mode: "latch", debounceSeconds: 0.01, maxRetriesPerRequest: 2 },
      endpoints: [
        {
          id: "ep-1",
          name: "Mock Upstream 1",
          baseUrl: "http://127.0.0.1:19001/v1",
          apiKey: "sk-key-1",
        },
        {
          id: "ep-2",
          name: "Mock Upstream 2",
          baseUrl: "http://127.0.0.1:19002/v1",
          apiKey: "sk-key-2",
        },
      ],
      models: {
        aliases: {
          "deepseek-chat": "deepseek-v4-flash",
        },
      },
    };

    const latch = new RSLatchManager(config);
    expect(latch.getActiveIndex()).toBe(0);

    const clientReq = new Request("http://127.0.0.1:8080/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [{ role: "user", content: "Hello" }],
        stream: true,
      }),
    });

    const response = await handleProxyRequest({
      req: clientReq,
      url: new URL(clientReq.url),
      latch,
      config,
    });

    // Client receives 200 OK from Key 2
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Gateway-Active-Endpoint")).toBe("ep-2");
    expect(response.headers.get("X-Gateway-Attempt")).toBe("2");

    const text = await response.text();
    expect(text).toContain("reasoning_content");
    expect(text).toContain("Thinking steps...");
    expect(text).toContain("DeepSeek answer text.");

    // Latch is now locked onto Key 2
    expect(latch.getActiveIndex()).toBe(1);
    expect(latch.getActiveEndpoint().id).toBe("ep-2");

    // Next request goes directly to Key 2 without touching Key 1
    const beforeHits2 = server2Hits;
    const beforeHits1 = server1Hits;

    const secondReq = new Request("http://127.0.0.1:8080/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "deepseek-v4-flash", messages: [] }),
    });

    const secondRes = await handleProxyRequest({
      req: secondReq,
      url: new URL(secondReq.url),
      latch,
      config,
    });

    expect(secondRes.status).toBe(200);
    expect(secondRes.headers.get("X-Gateway-Attempt")).toBe("1"); // Directly hit on 1st attempt
    expect(server2Hits).toBe(beforeHits2 + 1);
    expect(server1Hits).toBe(beforeHits1); // Key 1 was untouched!
  });

  it("routes dedicated models to their own endpoint, bypassing the latch pool", async () => {
    const config: GatewayConfig = {
      server: { host: "127.0.0.1", port: 8080, timeoutSeconds: 10 },
      strategy: { mode: "latch", debounceSeconds: 0.01, maxRetriesPerRequest: 2 },
      endpoints: [
        {
          id: "dedicated-1",
          name: "Dedicated V4 Pro",
          baseUrl: "http://127.0.0.1:19003/v1",
          apiKey: "sk-dedicated",
          models: ["deepseek-v4-pro"],
          modelMap: { "deepseek-v4-pro": "deepseek/deepseek-v4-pro" },
        },
        {
          id: "ep-1",
          name: "Mock Upstream 1",
          baseUrl: "http://127.0.0.1:19001/v1",
          apiKey: "sk-key-1",
        },
        {
          id: "ep-2",
          name: "Mock Upstream 2",
          baseUrl: "http://127.0.0.1:19002/v1",
          apiKey: "sk-key-2",
        },
      ],
      models: { aliases: {} },
    };

    const latch = new RSLatchManager(config);
    const hitsBefore = { s1: server1Hits, s2: server2Hits, s3: server3Hits };

    // V4 Pro request -> dedicated endpoint, latch pool untouched
    const proReq = new Request("http://127.0.0.1:8080/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    const proRes = await handleProxyRequest({
      req: proReq,
      url: new URL(proReq.url),
      latch,
      config,
    });

    expect(proRes.status).toBe(200);
    expect(proRes.headers.get("X-Gateway-Active-Endpoint")).toBe("dedicated-1");
    expect(server3Hits).toBe(hitsBefore.s3 + 1);
    expect(server3ReceivedModel).toBe("deepseek/deepseek-v4-pro"); // model_map rewrite applied
    expect(server1Hits).toBe(hitsBefore.s1); // latch untouched
    expect(server2Hits).toBe(hitsBefore.s2);
    expect(latch.getActiveIndex()).toBe(0);

    // V4 Flash request -> latch pool, dedicated endpoint untouched
    const flashReq = new Request("http://127.0.0.1:8080/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "deepseek-v4-flash", messages: [] }),
    });
    const flashRes = await handleProxyRequest({
      req: flashReq,
      url: new URL(flashReq.url),
      latch,
      config,
    });

    expect(flashRes.status).toBe(200);
    expect(flashRes.headers.get("X-Gateway-Active-Endpoint")).toBe("ep-2"); // latch pool (ep-1 429 -> ep-2)
    expect(server3Hits).toBe(hitsBefore.s3 + 1); // dedicated untouched
  });

  it("strips response_format when the endpoint declares compat.strip_response_format", async () => {
    const config = compatTestConfig({ stripResponseFormat: true });
    const latch = new RSLatchManager(config);
    server4ReceivedBody = null;

    const response = await postChat(latch, config, {
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "Return JSON only" }],
      response_format: { type: "json_object" },
      max_completion_tokens: 64,
    });

    expect(response.status).toBe(200);
    expect(server4ReceivedBody).not.toBeNull();
    expect(server4ReceivedBody!.response_format).toBeUndefined();
    expect(server4ReceivedBody!.model).toBe("deepseek/deepseek-v4-pro"); // model_map still applied
    expect(server4ReceivedBody!.max_completion_tokens).toBe(64); // other params untouched
  });

  it("preserves response_format when the endpoint declares no compat", async () => {
    const config = compatTestConfig(undefined);
    const latch = new RSLatchManager(config);
    server4ReceivedBody = null;

    const response = await postChat(latch, config, {
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "Return JSON only" }],
      response_format: { type: "json_object" },
    });

    expect(response.status).toBe(200);
    expect(server4ReceivedBody).not.toBeNull();
    expect(server4ReceivedBody!.response_format).toEqual({ type: "json_object" });
  });

  it("renames a non-official reasoning field to reasoning_content and drops its details field", async () => {
    const config = compatTestConfig({ responseReasoningField: "reasoning" });
    const latch = new RSLatchManager(config);
    server4Mode = "rename";

    const response = await postChat(latch, config, {
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "Return JSON only" }],
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    const message = body.choices[0].message;
    expect(message.reasoning_content).toBe("Hidden chain of thought.");
    expect(message.reasoning).toBeUndefined();
    expect(message.reasoning_details).toBeUndefined();
    expect(message.content).toBe('{"answer":42}'); // other fields untouched
  });

  it("unwraps double-wrapped upstream errors into the official single-layer shape", async () => {
    const config = compatTestConfig({ unwrapError: true });
    const latch = new RSLatchManager(config);
    server4Mode = "double-error";

    const response = await postChat(latch, config, {
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.message).toBe("Invalid input"); // single layer, no nested JSON string
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.param).toBe("response_format");
    expect(body.error.code).toBe("invalid_request_error");
    expect(typeof body.error.message).toBe("string");
  });

  it("forwards upstream errors verbatim when the error body is not double-wrapped", async () => {
    const config = compatTestConfig({ unwrapError: true });
    const latch = new RSLatchManager(config);
    server4Mode = "plain-error";

    const response = await postChat(latch, config, {
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hi" }],
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.message).toBe("not json inside at all"); // unchanged passthrough
  });

  it("rewrites reasoning field names in SSE deltas and preserves [DONE]", async () => {
    const config = compatTestConfig({ responseReasoningField: "reasoning" });
    const latch = new RSLatchManager(config);
    server4Mode = "rename-sse";

    const response = await postChat(latch, config, {
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('"reasoning_content":"Think"');
    expect(text).toContain('"content":"{\"answer\":42}"');
    expect(text).not.toContain('"reasoning":');
    expect(text).not.toContain("reasoning_details");
    expect(text).toContain("data: [DONE]");
  });

  it("rejects response_format.type json_schema at the router without touching any upstream", async () => {
    const config = compatTestConfig(undefined);
    const latch = new RSLatchManager(config);
    const hitsBefore = { s4: server4Hits, s1: server1Hits, s2: server2Hits };

    const response = await postChat(latch, config, {
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hi" }],
      response_format: { type: "json_schema", json_schema: { name: "x", schema: {} } },
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.param).toBe("response_format");
    expect(body.error.code).toBe("invalid_request_error");
    expect(body.error.message).toContain('got "json_schema"');
    // Dedicated route and latch pool both untouched
    expect(server4Hits).toBe(hitsBefore.s4);
    expect(server1Hits).toBe(hitsBefore.s1);
    expect(server2Hits).toBe(hitsBefore.s2);
  });

  it("allows response_format: null as an official opt-out and strips it for compat endpoints", async () => {
    const config = compatTestConfig({ stripResponseFormat: true });
    const latch = new RSLatchManager(config);
    server4ReceivedBody = null;

    const response = await postChat(latch, config, {
      model: "deepseek-v4-pro",
      messages: [{ role: "user", content: "hi" }],
      response_format: null,
    });

    // null = official "no JSON mode" opt-out: forwarded, not 400'd
    expect(response.status).toBe(200);
    expect(server4ReceivedBody).not.toBeNull();
    expect(server4ReceivedBody!.response_format).toBeUndefined(); // stripped for the compat endpoint
  });

  it("forwards malformed non-object bodies to the upstream instead of crashing", async () => {
    const config = compatTestConfig({ stripResponseFormat: true });
    const latch = new RSLatchManager(config);
    const hitsBefore = server2Hits;

    // No `model` -> latch pool (19002 mock); a crash would surface as 500/502.
    for (const rawBody of ["null", '"abc"', "42"]) {
      const req = new Request("http://127.0.0.1:8080/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: rawBody,
      });
      const response = await handleProxyRequest({ req, url: new URL(req.url), latch, config });
      expect(response.status).toBe(200);
    }
    expect(server2Hits).toBe(hitsBefore + 3);
  });

  it("rejects models outside the allowlist", async () => {
    const config: GatewayConfig = {
      server: { host: "127.0.0.1", port: 8080, timeoutSeconds: 10 },
      strategy: { mode: "latch", debounceSeconds: 0.01, maxRetriesPerRequest: 2 },
      endpoints: [
        {
          id: "ep-1",
          name: "Mock Upstream 1",
          baseUrl: "http://127.0.0.1:19001/v1",
          apiKey: "sk-key-1",
        },
        {
          id: "ep-2",
          name: "Mock Upstream 2",
          baseUrl: "http://127.0.0.1:19002/v1",
          apiKey: "sk-key-2",
        },
      ],
      models: {
        aliases: {},
        allow: ["deepseek-v4-flash", "deepseek-v4-pro"],
      },
    };

    const latch = new RSLatchManager(config);
    const hitsBefore = { s1: server1Hits, s2: server2Hits };

    // deepseek-chat must be refused outright (legacy alias disabled)
    const chatReq = new Request("http://127.0.0.1:8080/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "deepseek-chat", messages: [] }),
    });
    const chatRes = await handleProxyRequest({
      req: chatReq,
      url: new URL(chatReq.url),
      latch,
      config,
    });

    expect(chatRes.status).toBe(400);
    const body = await chatRes.json();
    expect(body.error.code).toBe("model_not_allowed");
    expect(body.error.message).toContain("deepseek-chat");
    expect(server1Hits).toBe(hitsBefore.s1); // no upstream was touched
    expect(server2Hits).toBe(hitsBefore.s2);

    // Allowed model still flows
    const okReq = new Request("http://127.0.0.1:8080/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "deepseek-v4-flash", messages: [] }),
    });
    const okRes = await handleProxyRequest({
      req: okReq,
      url: new URL(okReq.url),
      latch,
      config,
    });
    expect(okRes.status).toBe(200);
    expect(server2Hits).toBe(hitsBefore.s2 + 1);
  });

  it("does not flip the latch on a transient network error; retries same endpoint", async () => {
    const config: GatewayConfig = {
      server: { host: "127.0.0.1", port: 8080, timeoutSeconds: 10 },
      strategy: { mode: "latch", debounceSeconds: 0.01, maxRetriesPerRequest: 2 },
      endpoints: [
        {
          id: "ep-flaky",
          name: "Flaky Upstream",
          baseUrl: "http://127.0.0.1:19002/v1", // healthy (200) mock
          apiKey: "sk-flaky",
        },
        {
          id: "ep-1",
          name: "Mock Upstream 1",
          baseUrl: "http://127.0.0.1:19001/v1", // 429 mock
          apiKey: "sk-key-1",
        },
      ],
      models: { aliases: {} },
    };

    const latch = new RSLatchManager(config);
    const realFetch = globalThis.fetch;
    let patchedCalls = 0;
    globalThis.fetch = (async (url: any, init?: any) => {
      patchedCalls++;
      if (patchedCalls === 1) {
        throw new Error("The socket connection was closed unexpectedly");
      }
      return realFetch(url as any, init as any);
    }) as typeof fetch;

    try {
      const clientReq = new Request("http://127.0.0.1:8080/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "deepseek-v4-flash", messages: [] }),
      });

      const response = await handleProxyRequest({
        req: clientReq,
        url: new URL(clientReq.url),
        latch,
        config,
      });

      // Transient network error must NOT flip the latch away from a healthy key,
      // and the same endpoint must be retried so the request succeeds.
      expect(response.status).toBe(200);
      expect(response.headers.get("X-Gateway-Active-Endpoint")).toBe("ep-flaky");
      expect(response.headers.get("X-Gateway-Attempt")).toBe("2");
      expect(latch.getActiveIndex()).toBe(0);
      expect(latch.getStatus().totalSwitches).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("returns 502 (not 429) when all attempts fail with network errors; latch untouched", async () => {
    const config: GatewayConfig = {
      server: { host: "127.0.0.1", port: 8080, timeoutSeconds: 10 },
      strategy: { mode: "latch", debounceSeconds: 0.01, maxRetriesPerRequest: 2 },
      endpoints: [
        {
          id: "ep-down",
          name: "Down Upstream",
          baseUrl: "http://127.0.0.1:19002/v1",
          apiKey: "sk-down",
        },
        {
          id: "ep-1",
          name: "Mock Upstream 1",
          baseUrl: "http://127.0.0.1:19001/v1",
          apiKey: "sk-key-1",
        },
      ],
      models: { aliases: {} },
    };

    const latch = new RSLatchManager(config);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: any, _init?: any) => {
      throw new Error("The socket connection was closed unexpectedly");
    }) as unknown as typeof fetch;

    try {
      const clientReq = new Request("http://127.0.0.1:8080/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "deepseek-v4-flash", messages: [] }),
      });

      const response = await handleProxyRequest({
        req: clientReq,
        url: new URL(clientReq.url),
        latch,
        config,
      });

      // A connectivity failure is NOT quota exhaustion: report 502 upstream
      // unreachable, never a false "all endpoints exhausted" 429.
      expect(response.status).toBe(502);
      const body = await response.json();
      expect(body.error.code).toBe("upstream_unreachable");
      // Each endpoint failed twice, so the latch advanced away and back
      // (bounded flip on repeated network failures, not on transient ones).
      expect(latch.getActiveIndex()).toBe(0);
      expect(latch.getStatus().totalSwitches).toBe(2);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("reports 429 quota exhaustion when an endpoint gave a definitive 429 verdict, even if a later attempt hit a network error", async () => {
    const config: GatewayConfig = {
      server: { host: "127.0.0.1", port: 8080, timeoutSeconds: 10 },
      strategy: { mode: "latch", debounceSeconds: 0.01, maxRetriesPerRequest: 2 },
      endpoints: [
        {
          id: "ep-1",
          name: "Mock Upstream 1",
          baseUrl: "http://127.0.0.1:19001/v1", // 429 mock
          apiKey: "sk-key-1",
        },
        {
          id: "ep-down",
          name: "Down Upstream",
          baseUrl: "http://127.0.0.1:19002/v1",
          apiKey: "sk-down",
        },
      ],
      models: { aliases: {} },
    };

    const latch = new RSLatchManager(config);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init?: any) => {
      // Only the down endpoint (19002) is unreachable; 19001 must pass through
      // so the first attempt gets a genuine 429 verdict from the mock.
      if (String(url).includes("19002")) {
        throw new Error("The socket connection was closed unexpectedly");
      }
      return realFetch(url as any, init as any);
    }) as typeof fetch;

    try {
      const clientReq = new Request("http://127.0.0.1:8080/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "deepseek-v4-flash", messages: [] }),
      });

      const response = await handleProxyRequest({
        req: clientReq,
        url: new URL(clientReq.url),
        latch,
        config,
      });

      // Key 1 responded with a definitive 429; key 2 was unreachable. The quota
      // verdict must win: report 429 insufficient_quota, not 502.
      expect(response.status).toBe(429);
      const body = await response.json();
      expect(body.error.type).toBe("insufficient_quota");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("probes another endpoint after two consecutive network failures on the same endpoint", async () => {
    const config: GatewayConfig = {
      server: { host: "127.0.0.1", port: 8080, timeoutSeconds: 10 },
      strategy: { mode: "latch", debounceSeconds: 0.01, maxRetriesPerRequest: 3 },
      endpoints: [
        {
          id: "ep-down",
          name: "Down Upstream",
          baseUrl: "http://127.0.0.1:19002/v1",
          apiKey: "sk-down",
        },
        {
          id: "ep-healthy",
          name: "Healthy Upstream",
          baseUrl: "http://127.0.0.1:19002/v1",
          apiKey: "sk-healthy",
        },
      ],
      models: { aliases: {} },
    };

    const latch = new RSLatchManager(config);
    const realFetch = globalThis.fetch;
    let patchedCalls = 0;
    globalThis.fetch = (async (url: any, init?: any) => {
      patchedCalls++;
      if (patchedCalls <= 2) {
        throw new Error("The socket connection was closed unexpectedly");
      }
      return realFetch(url as any, init as any);
    }) as typeof fetch;

    try {
      const clientReq = new Request("http://127.0.0.1:8080/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "deepseek-v4-flash", messages: [] }),
      });

      const response = await handleProxyRequest({
        req: clientReq,
        url: new URL(clientReq.url),
        latch,
        config,
      });

      // ep-down fails twice (its free retry) -> skipped and the latch advances
      // to ep-healthy, which succeeds.
      expect(response.status).toBe(200);
      expect(response.headers.get("X-Gateway-Active-Endpoint")).toBe("ep-healthy");
      expect(response.headers.get("X-Gateway-Attempt")).toBe("3"); // 3 upstream calls
      expect(latch.getActiveIndex()).toBe(1); // advanced away from the down endpoint
      expect(latch.getStatus().totalSwitches).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("reaches the healthy key even when the latch flip is debounced", async () => {
    const config: GatewayConfig = {
      server: { host: "127.0.0.1", port: 8080, timeoutSeconds: 10 },
      strategy: { mode: "latch", debounceSeconds: 0.2, maxRetriesPerRequest: 2 },
      endpoints: [
        {
          id: "ep-1",
          name: "Mock Upstream 1",
          baseUrl: "http://127.0.0.1:19001/v1", // 429 mock
          apiKey: "sk-key-1",
        },
        {
          id: "ep-2",
          name: "Mock Upstream 2",
          baseUrl: "http://127.0.0.1:19002/v1", // healthy mock
          apiKey: "sk-key-2",
        },
      ],
      models: { aliases: {} },
    };

    const latch = new RSLatchManager(config);
    // Arrange the latch on index 0 while its debounce window for index 0 is
    // still fresh: trigger429(0) below will be debounce-blocked and the global
    // activeIndex will not move.
    latch.trigger429(0, "earlier 429"); // 0 -> 1
    latch.trigger429(1, "earlier 429"); // 1 -> 0
    expect(latch.getActiveIndex()).toBe(0);

    const clientReq = new Request("http://127.0.0.1:8080/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "deepseek-v4-flash", messages: [] }),
    });

    const response = await handleProxyRequest({
      req: clientReq,
      url: new URL(clientReq.url),
      latch,
      config,
    });

    // Key 1 429s but its flip is debounced; the request must still advance to
    // the healthy key 2 instead of re-hitting key 1 and failing with a false
    // "all endpoints exhausted" 429.
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Gateway-Active-Endpoint")).toBe("ep-2");
    expect(response.headers.get("X-Gateway-Attempt")).toBe("2");
    expect(latch.getActiveIndex()).toBe(0); // global latch state unchanged (debounced)
  });
});
