import { expect, it } from "bun:test";
import { RSLatchManager } from "../src/latch";
import { PriorityLatchManager } from "../src/priority-latch";
import { handleProxyRequest } from "../src/proxy";
import type { GatewayConfig } from "../src/types";

const expired = {
  error: {
    type: "authentication_error",
    code: "api_key_expired",
    message: "This API key has expired.",
  },
};

for (const Manager of [PriorityLatchManager, RSLatchManager]) {
  for (const statuses of [[401, 200], [401, 401]]) {
    const allExpired = statuses[1] === 401;
    it(`${Manager.name} ${allExpired ? "reports unreachable when every key is rejected" : "skips an expired key"}`, async () => {
      const hits = [0, 0];
      const servers = statuses.map((status, index) => Bun.serve({
        port: 0,
        fetch() {
          hits[index]++;
          return Response.json(status === 200
            ? { choices: [{ message: { role: "assistant", content: "OK" } }] }
            : expired,
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
          strategy: { mode: "latch", debounceSeconds: 0, maxRetriesPerRequest: 2 },
          endpoints,
          routing: { routes: { "deepseek-flash": {
            mode: "priority-latch",
            groups: [{ id: "opencode-go", priority: 1, mode: "latch", members: endpoints.map(ep => ({ endpointId: ep.id })) }],
          } } },
        };
        const latch = new Manager(config);
        const req = new Request("http://localhost/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-opencode-session": "auth-test" },
          body: JSON.stringify({ model: "deepseek-flash", messages: [] }),
        });
        const response = await handleProxyRequest({ req, url: new URL(req.url), latch, config });
        expect(hits).toEqual([1, 1]);
        expect(latch.getStatus().endpoints[0].errors429).toBe(0);
        if (allExpired) {
          expect(response.status).toBe(502);
        } else {
          expect(response.status).toBe(200);
          expect(response.headers.get("X-Gateway-Active-Endpoint")).toBe("opencode-go-2");
          expect((await response.json()).choices[0].message.content).toBe("OK");
        }
      } finally {
        servers.forEach(server => server.stop());
      }
    });
  }
}
