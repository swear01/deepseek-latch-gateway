import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "deepseek-gateway-timeout-"));

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("gateway server timeout", () => {
  it("keeps an in-flight request open for the configured timeout", async () => {
    const upstream = Bun.serve({
      port: 0,
      idleTimeout: 15,
      fetch() {
        return new Response(new ReadableStream({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode("data: first\n\n"));
            await Bun.sleep(12_500);
            controller.enqueue(new TextEncoder().encode("data: done\n\n"));
            controller.close();
          },
        }), { headers: { "Content-Type": "text/event-stream" } });
      },
    });
    const reservation = Bun.serve({ port: 0, fetch: () => new Response("reserved") });
    const gatewayPort = reservation.port;
    reservation.stop(true);
    const configPath = join(root, "config.yaml");
    writeFileSync(configPath, `
server:
  host: "127.0.0.1"
  port: ${gatewayPort}
  timeout_seconds: 15
strategy:
  mode: "latch"
  max_retries_per_request: 1
endpoints:
  - id: "slow"
    name: "Slow upstream"
    base_url: "http://127.0.0.1:${upstream.port}/v1"
    api_key: "test"
`);
    const gateway = Bun.spawn(["bun", "run", "src/index.ts", configPath], {
      cwd: process.cwd(),
      stdout: "ignore",
      stderr: "ignore",
    });

    try {
      const healthUrl = `http://127.0.0.1:${gatewayPort}/healthz`;
      const deadline = Date.now() + 5_000;
      while (true) {
        try {
          if ((await fetch(healthUrl)).ok) break;
        } catch {
          if (Date.now() >= deadline) throw new Error("gateway did not start");
          await Bun.sleep(25);
        }
      }
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "deepseek-chat", messages: [{ role: "user", content: "test" }] }),
      });

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("data: first\n\ndata: done\n\n");
    } finally {
      gateway.kill();
      await gateway.exited;
      upstream.stop(true);
    }
  }, 20_000);
});
