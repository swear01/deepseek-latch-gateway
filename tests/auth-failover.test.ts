import { expect, it, spyOn } from "bun:test";
import { RSLatchManager } from "../src/latch";
import { PriorityLatchManager } from "../src/priority-latch";
import { handleProxyRequest } from "../src/proxy";
import type { GatewayConfig } from "../src/types";

const apiKey = (index: number) => `plain-configured-secret-${index + 1}-${"x".repeat(600)}`;

function expiredBody(index: number) {
  return {
    error: {
      type: "authentication_error",
      code: "api_key_expired",
      message: `Key ${apiKey(index)} has expired (oc_sk_echoedSecretValue123), reason token_not_supported.\nFORGED-LOG-LINE Authorization: Bearer bearerSecret7 sk-proj-skSecret42 X-Api-Key: headerformSecretabcdefghijkl api_key=underscoreSecret5`,
    },
  };
}

function captureConsole() {
  const logged: string[] = [];
  const spies = (["warn", "error", "log"] as const).map(level =>
    spyOn(console, level).mockImplementation((...args) => { logged.push(args.join(" ")); })
  );
  return { logged, restore: () => spies.forEach(spy => spy.mockRestore()) };
}

function expectNoSecrets(text: string) {
  expect(text).not.toContain("echoedSecretValue");
  expect(text).not.toContain("plain-configured-secret");
  expect(text).not.toContain("clientQuerySecret");
  expect(text).not.toContain("bearerSecret");
  expect(text).not.toContain("skSecret");
  expect(text).not.toContain("headerformSecret");
  expect(text).not.toContain("underscoreSecret");
  expect(text).not.toMatch(/\nFORGED-LOG-LINE/);
}

function chatRequest(model: string, query = "") {
  return new Request(`http://localhost/v1/chat/completions${query}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-opencode-session": "auth-test" },
    body: JSON.stringify({ model, messages: [] }),
  });
}

type Upstream = 401 | 429 | 200 | "down";
const cases: { upstreams: Upstream[]; status: number; code?: string | number; title: string }[] = [
  { upstreams: [401, 200], status: 200, title: "skips an expired key" },
  { upstreams: [401, 401], status: 502, code: "upstream_auth_failed", title: "reports an auth failure when every key is rejected" },
  { upstreams: [401, "down"], status: 502, code: "upstream_unreachable", title: "reports unreachable when failures are mixed" },
  { upstreams: [401, 429], status: 429, code: 429, title: "reports quota exhaustion after an expired key" },
];

for (const Manager of [PriorityLatchManager, RSLatchManager]) {
  for (const { upstreams, status, code, title } of cases) {
    it(`${Manager.name} ${title}`, async () => {
      const hits = [0, 0];
      const output = captureConsole();
      const servers = upstreams.map((upstream, index) => Bun.serve({
        port: 0,
        fetch() {
          hits[index]++;
          if (upstream === 200) return Response.json({ choices: [{ message: { role: "assistant", content: "OK" } }] });
          if (upstream === 429) return Response.json({ error: { message: "Go usage limit exceeded" } }, { status: 429 });
          return Response.json(expiredBody(index), { status: 401 });
        },
      }));
      const ports = servers.map(server => server.port);
      servers.forEach((server, index) => { if (upstreams[index] === "down") server.stop(true); });
      try {
        const endpoints = ports.map((port, index) => ({
          id: `opencode-go-${index + 1}`,
          name: `Account ${index + 1}`,
          baseUrl: `http://127.0.0.1:${port}/v1`,
          apiKey: apiKey(index),
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
        const req = chatRequest("deepseek-flash");
        const response = await handleProxyRequest({ req, url: new URL(req.url), latch, config });
        expect(response.status).toBe(status);
        expect(hits[0]).toBe(1);
        expect(latch.getStatus().endpoints[0].errors429).toBe(0);
        const body = await response.json();
        if (code) {
          expect(body.error.code).toBe(code);
          expect(Number(response.headers.get("X-Gateway-Attempt"))).toBeGreaterThanOrEqual(2);
        } else {
          expect(response.headers.get("X-Gateway-Active-Endpoint")).toBe("opencode-go-2");
          expect(body.choices[0].message.content).toBe("OK");
        }
        expect(output.logged.some(line => line.includes("Upstream 401 Auth") && line.includes("token_not_supported"))).toBe(true);
        expectNoSecrets(output.logged.join("\n"));
      } finally {
        output.restore();
        servers.forEach(server => server.stop(true));
      }
    });
  }
}

it("priority route skips duplicate members backed by a rejected endpoint", async () => {
  const output = captureConsole();
  let hits = 0;
  const server = Bun.serve({ port: 0, fetch: () => { hits++; return Response.json(expiredBody(0), { status: 401 }); } });
  try {
    const endpoint = { id: "opencode-go-1", name: "Account 1", baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: apiKey(0) };
    const config: GatewayConfig = {
      server: { host: "127.0.0.1", port: 8080, timeoutSeconds: 10 },
      strategy: { mode: "latch", debounceSeconds: 0, maxRetriesPerRequest: 2 },
      endpoints: [endpoint],
      routing: { routes: { "deepseek-flash": {
        mode: "priority-latch",
        groups: [
          { id: "first", priority: 1, mode: "latch", members: [{ endpointId: endpoint.id }] },
          { id: "second", priority: 2, mode: "latch", members: [{ endpointId: endpoint.id }] },
        ],
      } } },
    };
    const latch = new PriorityLatchManager(config);
    const req = chatRequest("deepseek-flash");
    const response = await handleProxyRequest({ req, url: new URL(req.url), latch, config });
    expect(hits).toBe(1);
    expect(response.status).toBe(502);
    expect((await response.json()).error.code).toBe("upstream_auth_failed");
  } finally {
    output.restore();
    server.stop(true);
  }
});

it("dedicated endpoint hides a rejected credential from the client", async () => {
  const output = captureConsole();
  const headerSecret = 'quoted"Header\\Secret';
  const server = Bun.serve({ port: 0, fetch: () => Response.json({
    error: { message: `header ${headerSecret} rejected` },
  }, { status: 401 }) });
  try {
    const config: GatewayConfig = {
      server: { host: "127.0.0.1", port: 8080, timeoutSeconds: 10 },
      strategy: { mode: "latch", debounceSeconds: 0, maxRetriesPerRequest: 1 },
      endpoints: [
        { id: "dedicated", name: "Dedicated", baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: apiKey(0), models: ["dedicated-model"], extraHeaders: { "Cookie": headerSecret } },
        { id: "pool", name: "Pool", baseUrl: "http://127.0.0.1:9/v1", apiKey: apiKey(1) },
      ],
    };
    const latch = new RSLatchManager(config);
    const req = chatRequest("dedicated-model", "?key=clientQuerySecret9");
    const response = await handleProxyRequest({ req, url: new URL(req.url), latch, config });
    const text = await response.text();
    expect(response.status).toBe(502);
    expect(JSON.parse(text).error.code).toBe("upstream_auth_failed");
    expect(response.headers.get("X-Gateway-Attempt")).toBe("1");
    expect(response.headers.get("X-Gateway-Active-Endpoint")).toBe("dedicated");
    expectNoSecrets(text);
    expectNoSecrets(output.logged.join("\n"));
    expect(output.logged.join("\n")).not.toContain("Header");
  } finally {
    output.restore();
    server.stop(true);
  }
});
