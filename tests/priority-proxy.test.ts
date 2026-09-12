import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { PriorityLatchManager } from "../src/priority-latch";
import { handleProxyRequest } from "../src/proxy";
import type { GatewayConfig } from "../src/types";

let openCode1: ReturnType<typeof Bun.serve>;
let openCode2: ReturnType<typeof Bun.serve>;
let openCode3: ReturnType<typeof Bun.serve>;
let commandCode: ReturnType<typeof Bun.serve>;
let openRouter: ReturnType<typeof Bun.serve>;
let commandHits = 0;
let commandModel = "";
let commandCodeStatus = 200;
let openRouterHits = 0;
let openRouterBody: Record<string, unknown> | undefined;
let openCode1Status = 429;

function quotaServer(
  port: number,
  retryAfter?: string,
  status: () => number = () => 429
): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port,
    fetch() {
      const responseStatus = status();
      return Response.json(
        responseStatus === 429
          ? { error: { message: "weekly usage limit", type: "insufficient_quota" } }
          : { error: { message: "internal failure", type: "server_error" } },
        {
          status: responseStatus,
          headers: responseStatus === 429 && retryAfter ? { "Retry-After": retryAfter } : undefined,
        }
      );
    },
  });
}

beforeAll(() => {
  openCode1 = quotaServer(19101, "7200", () => openCode1Status);
  openCode2 = quotaServer(19102);
  openCode3 = quotaServer(19103);
  commandCode = Bun.serve({
    port: 19104,
    async fetch(req) {
      if (commandCodeStatus === 429) {
        return Response.json(
          { error: { message: "weekly usage limit", type: "insufficient_quota" } },
          { status: 429 }
        );
      }
      commandHits++;
      const body = await req.json();
      commandModel = body?.model;
      return Response.json({ choices: [{ message: { role: "assistant", content: "fallback" } }] });
    },
  });
  openRouter = Bun.serve({
    port: 19105,
    async fetch(req) {
      openRouterHits++;
      openRouterBody = await req.json();
      return Response.json({ choices: [{ message: { role: "assistant", content: "openrouter" } }] });
    },
  });
});

afterAll(() => {
  openCode1.stop();
  openCode2.stop();
  openCode3.stop();
  commandCode.stop();
  openRouter.stop();
});

function createConfig(): GatewayConfig {
  return {
    server: { host: "127.0.0.1", port: 8080, timeoutSeconds: 10 },
    strategy: { mode: "latch", debounceSeconds: 0.01, maxRetriesPerRequest: 4 },
    endpoints: [
      {
        id: "opencode-go-1",
        name: "OpenCode Go (Account 1)",
        baseUrl: "http://127.0.0.1:19101/v1",
        apiKey: "key-1",
      },
      {
        id: "opencode-go-2",
        name: "OpenCode Go (Account 2)",
        baseUrl: "http://127.0.0.1:19102/v1",
        apiKey: "key-2",
      },
      {
        id: "opencode-go-3",
        name: "OpenCode Go (Account 3)",
        baseUrl: "http://127.0.0.1:19103/v1",
        apiKey: "key-3",
      },
      {
        id: "command-code",
        name: "Command Code",
        baseUrl: "http://127.0.0.1:19104/v1",
        apiKey: "command-key",
      },
    ],
    routing: {
      routes: {
        "deepseek-v4-flash": {
          mode: "priority-latch",
          groups: [
            {
              id: "opencode-go",
              priority: 1,
              mode: "latch",
              members: [
                { endpointId: "opencode-go-1" },
                { endpointId: "opencode-go-2" },
                { endpointId: "opencode-go-3" },
              ],
            },
            {
              id: "command-code-fallback",
              priority: 2,
              mode: "latch",
              members: [
                {
                  endpointId: "command-code",
                  upstreamModel: "deepseek/deepseek-v4-flash",
                },
              ],
            },
          ],
        },
      },
    },
    models: { aliases: {} },
  };
}

function postChat(manager: PriorityLatchManager, config: GatewayConfig) {
  const req = new Request("http://127.0.0.1:8080/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "deepseek-v4-flash", messages: [] }),
  });
  return handleProxyRequest({ req, url: new URL(req.url), latch: manager, config });
}

describe("hierarchical priority routing", () => {
  it("tries all three OpenCode keys before Command Code and keeps fallback during cooldown", async () => {
    const config = createConfig();
    const manager = new PriorityLatchManager(config);

    const response = await postChat(manager, config);

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Gateway-Active-Endpoint")).toBe("command-code");
    expect(response.headers.get("X-Gateway-Attempt")).toBe("4");
    expect(commandModel).toBe("deepseek/deepseek-v4-flash");

    const key1 = manager.getStatus().endpoints.find((endpoint) => endpoint.id === "opencode-go-1")!;
    const cooldown = Date.parse(key1.blockedUntil!) - Date.now();
    expect(cooldown).toBeGreaterThan(5_399_000);
    expect(cooldown).toBeLessThanOrEqual(5_400_000);

    const hitsBefore = commandHits;
    const secondResponse = await postChat(manager, config);
    expect(secondResponse.status).toBe(200);
    expect(secondResponse.headers.get("X-Gateway-Attempt")).toBe("1");
    expect(commandHits).toBe(hitsBefore + 1);
    expect(manager.getAttempt("deepseek-v4-flash")?.endpoint.id).toBe("command-code");
  });

  it("keeps a failed half-open probe transparent by continuing to fallback", async () => {
    let now = 0;
    const config = createConfig();
    const manager = new PriorityLatchManager(config, () => now);

    expect((await postChat(manager, config)).status).toBe(200);
    now = 2 * 60 * 60 * 1000;
    openCode1Status = 500;
    try {
      const response = await postChat(manager, config);
      expect(response.status).toBe(200);
      expect(response.headers.get("X-Gateway-Active-Endpoint")).toBe("command-code");
      expect(manager.getStatus().endpoints.some((endpoint) => endpoint.circuitState === "half-open")).toBe(false);
    } finally {
      openCode1Status = 429;
    }
  });

  it("treats OpenCode CreditsError 401 as quota and fails over to Command Code", async () => {
    const credits = Bun.serve({
      port: 19111,
      fetch() {
        return new Response(
          JSON.stringify({
            type: "error",
            error: {
              type: "CreditsError",
              message:
                "Insufficient balance. Manage your billing here: https://opencode.ai/workspace/wrk_example/billing",
            },
          }),
          { status: 401, headers: { "Content-Type": "application/json" } }
        );
      },
    });
    try {
      const config = createConfig();
      config.endpoints[0] = { ...config.endpoints[0], baseUrl: "http://127.0.0.1:19111/v1" };
      const manager = new PriorityLatchManager(config);

      const response = await postChat(manager, config);

      expect(response.status).toBe(200);
      expect(response.headers.get("X-Gateway-Active-Endpoint")).toBe("command-code");
      const key1 = manager.getStatus().endpoints.find((endpoint) => endpoint.id === "opencode-go-1")!;
      const cooldown = Date.parse(key1.blockedUntil!) - Date.now();
      expect(key1.errors429).toBe(1);
      expect(cooldown).toBeGreaterThan(5_399_000);
      expect(cooldown).toBeLessThanOrEqual(5_400_000);
    } finally {
      credits.stop();
    }
  });

  it("still reaches Command Code after a recovery probe even when the attempt budget is 1", async () => {
    let now = 0;
    const config = createConfig();
    const manager = new PriorityLatchManager(config, () => now);

    expect((await postChat(manager, config)).status).toBe(200);
    now = 2 * 60 * 60 * 1000;
    config.strategy.maxRetriesPerRequest = 1;
    const response = await postChat(manager, config);
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Gateway-Active-Endpoint")).toBe("command-code");
    expect(manager.getStatus()).toMatchObject({ activePriority: 2, activeGroup: "command-code-fallback" });
    expect(manager.getStatus().endpoints.some((endpoint) => endpoint.circuitState === "half-open")).toBe(false);
  });

  it("retries Command Code on the same request after every circuit has opened", async () => {
    const config = createConfig();
    const manager = new PriorityLatchManager(config);
    const model = "deepseek-v4-flash";

    expect((await postChat(manager, config)).status).toBe(200);
    const fallback = manager.getAttempt(model)!;
    expect(fallback.endpoint.id).toBe("command-code");
    manager.record429(model, fallback);
    manager.advance(model, fallback, "429");

    const response = await postChat(manager, config);
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Gateway-Active-Endpoint")).toBe("command-code");
  });

  it("walks OpenRouter after OpenCode and Command Code quota failures", async () => {
    const config = createConfig();
    config.endpoints.push({
      id: "openrouter",
      name: "OpenRouter (fast capped)",
      baseUrl: "http://127.0.0.1:19105/v1",
      apiKey: "or-key",
      extraBody: {
        model: "should-not-override-upstream-model",
        response_format: { type: "json_object" },
        provider: { sort: "throughput", max_price: { prompt: 0.15, completion: 0.60 } },
      },
    });
    config.routing!.routes["deepseek-v4-flash"].groups.push({
      id: "openrouter-fallback",
      priority: 3,
      mode: "latch",
      members: [{ endpointId: "openrouter", upstreamModel: "deepseek/deepseek-v4.1-flash" }],
    });
    commandCodeStatus = 429;
    openRouterHits = 0;
    openRouterBody = undefined;
    try {
      const manager = new PriorityLatchManager(config);
      const response = await postChat(manager, config);
      expect(response.status).toBe(200);
      expect(response.headers.get("X-Gateway-Active-Endpoint")).toBe("openrouter");
      expect(openRouterHits).toBe(1);
      expect(openRouterBody).toMatchObject({
        model: "deepseek/deepseek-v4.1-flash",
        provider: { sort: "throughput", max_price: { prompt: 0.15, completion: 0.60 } },
      });
      expect(openRouterBody).not.toHaveProperty("response_format");
    } finally {
      commandCodeStatus = 200;
    }
  });

  it("does not treat a null JSON body as a network failure when extraBody is set", async () => {
    const config = createConfig();
    for (const endpoint of config.endpoints) {
      endpoint.extraBody = { provider: { sort: "throughput" } };
    }
    const manager = new PriorityLatchManager(config);
    const req = new Request("http://127.0.0.1:8080/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "null",
    });
    const response = await handleProxyRequest({
      req,
      url: new URL(req.url),
      latch: manager,
      config,
    });
    expect(response.status).toBe(200);
  });

  it("returns 502 not 429 when every priority source is unreachable even if maxRetries exceeds route size", async () => {
    const config = createConfig();
    config.strategy.maxRetriesPerRequest = 10;
    const manager = new PriorityLatchManager(config);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("The socket connection was closed unexpectedly");
    }) as unknown as typeof fetch;
    try {
      const response = await postChat(manager, config);
      expect(response.status).toBe(502);
      const body = await response.json();
      expect(body.error.code).toBe("upstream_unreachable");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
