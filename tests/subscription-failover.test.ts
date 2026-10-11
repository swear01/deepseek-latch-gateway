import { expect, it } from "bun:test";
import { RSLatchManager } from "../src/latch";
import { PriorityLatchManager } from "../src/priority-latch";
import { handleProxyRequest } from "../src/proxy";
import type { GatewayConfig } from "../src/types";

for (const Manager of [PriorityLatchManager, RSLatchManager]) {
  for (const subscriptionRequired of [true, false]) {
    it(`${Manager.name} ${subscriptionRequired ? "skips an inactive subscription" : "preserves ordinary permission errors"} after quota exhaustion`, async () => {
      const hits = [0, 0, 0];
      const message = subscriptionRequired
        ? "Upstream request failed: An active OpenCode Go subscription is required to use Go models."
        : "Permission denied for this key";
      const servers = [429, 403, 200].map((status, index) => Bun.serve({
        port: 0,
        fetch(req) {
          hits[index]++;
          expect(req.headers.get("x-opencode-session")).toBe("subscription-test");
          return Response.json(status === 200
            ? { choices: [{ message: { role: "assistant", content: "OK" } }] }
            : { error: { type: "server_error", message: index === 0 ? "Go usage limit exceeded" : message } },
          { status });
        },
      }));
      try {
        const endpoints = servers.map((server, index) => ({
          id: `opencode-go-${index + 1}`,
          name: `Account ${index + 1}`,
          baseUrl: `http://127.0.0.1:${server.port}/v1`,
          apiKey: `key-${index + 1}`,
        }));
        const config: GatewayConfig = {
          server: { host: "127.0.0.1", port: 8080, timeoutSeconds: 10 },
          strategy: { mode: "latch", debounceSeconds: 0, maxRetriesPerRequest: 3 },
          endpoints,
          routing: { routes: { "deepseek-flash": {
            mode: "priority-latch",
            groups: [{ id: "opencode-go", priority: 1, mode: "latch", members: endpoints.map(ep => ({ endpointId: ep.id })) }],
          } } },
        };
        const latch = new Manager(config);
        const req = new Request("http://localhost/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-opencode-session": "subscription-test" },
          body: JSON.stringify({ model: "deepseek-flash", messages: [] }),
        });
        const response = await handleProxyRequest({ req, url: new URL(req.url), latch, config });
        expect(response.status).toBe(subscriptionRequired ? 200 : 403);
        expect(response.headers.get("X-Gateway-Attempt")).toBe(subscriptionRequired ? "3" : "2");
        expect(hits).toEqual(subscriptionRequired ? [1, 1, 1] : [1, 1, 0]);
        const body = await response.json();
        if (subscriptionRequired) {
          expect(body.choices[0].message.content).toBe("OK");
          expect(response.headers.get("X-Gateway-Active-Endpoint")).toBe("opencode-go-3");
          expect(latch.getStatus().endpoints[1].errors429).toBe(1);
          if (latch instanceof PriorityLatchManager) {
            expect(Date.parse(latch.getStatus().endpoints[1].blockedUntil!) - Date.now()).toBeGreaterThan(5_399_000);
          }
        } else {
          expect(body.error.message).toBe(message);
          expect(latch.getStatus().endpoints[1].errors429).toBe(0);
        }
      } finally {
        servers.forEach(server => server.stop());
      }
    });
  }
}
