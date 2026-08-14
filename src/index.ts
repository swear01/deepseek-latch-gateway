import { loadConfig } from "./config";
import { RSLatchManager } from "./latch";
import { handleProxyRequest } from "./proxy";

const configPath = process.argv[2] || process.env.GATEWAY_CONFIG;
const config = loadConfig(configPath);
const latch = new RSLatchManager(config);

const server = Bun.serve({
  hostname: config.server.host,
  port: config.server.port,
  async fetch(req) {
    const url = new URL(req.url);
    const pathname = url.pathname;

    // 1. Healthcheck Endpoint
    if (pathname === "/healthz" || pathname === "/health") {
      const activeEp = latch.getActiveEndpoint();
      return new Response(
        JSON.stringify({
          status: "ok",
          active_index: latch.getActiveIndex(),
          active_endpoint: activeEp.id,
          name: activeEp.name,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // 2. Gateway Status Endpoint
    if (pathname === "/status") {
      return new Response(JSON.stringify(latch.getStatus(), null, 2), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 3. Manual Switch Endpoint (POST /switch or POST /switch?index=1)
    if (pathname === "/switch" && req.method === "POST") {
      const queryIndex = url.searchParams.get("index");
      let targetIndex: number | undefined;
      if (queryIndex !== null) {
        targetIndex = parseInt(queryIndex, 10);
      }
      const switchResult = latch.forceSwitch(targetIndex);
      const activeEp = latch.getActiveEndpoint();
      return new Response(
        JSON.stringify({
          message: "RS-Latch switched successfully",
          old_index: switchResult.oldIndex,
          new_index: switchResult.newIndex,
          active_endpoint: activeEp.id,
          name: activeEp.name,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // 4. All Other LLM API Requests (OpenAI/Anthropic endpoints)
    return handleProxyRequest({ req, url, latch, config });
  },
});

console.log(
  `\x1b[32m🚀 DeepSeek Latch Gateway running on http://${server.hostname}:${server.port}\x1b[0m`
);
console.log(`[Config] Configured ${config.endpoints.length} endpoints in RS-Latch pool:`);
config.endpoints.forEach((ep, i) => {
  console.log(`  [${i}] ${ep.name} (${ep.id}) -> ${ep.baseUrl}`);
});
console.log(`[Status] Active Initial Endpoint: [0] ${config.endpoints[0].name}`);

process.on("SIGINT", () => {
  console.log("\n[Gateway] Shutting down...");
  server.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("\n[Gateway] Terminating...");
  server.stop();
  process.exit(0);
});
