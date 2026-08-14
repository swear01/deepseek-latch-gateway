import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { RSLatchManager } from "../src/latch";
import { handleProxyRequest } from "../src/proxy";
import type { GatewayConfig } from "../src/types";

let mockServer1: ReturnType<typeof Bun.serve>;
let mockServer2: ReturnType<typeof Bun.serve>;
let server1Hits = 0;
let server2Hits = 0;

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
});

afterAll(() => {
  mockServer1.stop();
  mockServer2.stop();
});

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
});
