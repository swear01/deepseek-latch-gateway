import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { PriorityLatchManager } from "../src/priority-latch";
import { handleProxyRequest } from "../src/proxy";
import type { GatewayConfig } from "../src/types";

let openCode1: ReturnType<typeof Bun.serve>;
let openCode2: ReturnType<typeof Bun.serve>;
let openCode3: ReturnType<typeof Bun.serve>;
let commandCode: ReturnType<typeof Bun.serve>;
let commandHits = 0;
let commandModel = "";
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
      commandHits++;
      const body = await req.json();
      commandModel = body.model;
      return Response.json({ choices: [{ message: { role: "assistant", content: "fallback" } }] });
    },
  });
});

afterAll(() => {
  openCode1.stop();
  openCode2.stop();
  openCode3.stop();
  commandCode.stop();
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
    const retryAfter = Date.parse(key1.blockedUntil!) - Date.now();
    expect(retryAfter).toBeGreaterThan(7_199_000);
    expect(retryAfter).toBeLessThanOrEqual(7_200_000);

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

  it("releases a half-open probe when the request attempt budget ends", async () => {
    let now = 0;
    const config = createConfig();
    const manager = new PriorityLatchManager(config, () => now);

    expect((await postChat(manager, config)).status).toBe(200);
    now = 2 * 60 * 60 * 1000;
    config.strategy.maxRetriesPerRequest = 1;
    expect((await postChat(manager, config)).status).toBe(429);
    expect(manager.getStatus()).toMatchObject({ activePriority: 2, activeGroup: "command-code-fallback" });
    expect(manager.getStatus().endpoints.some((endpoint) => endpoint.circuitState === "half-open")).toBe(false);
  });
});
