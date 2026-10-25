import { loadConfig } from "./config";
import { handleProxyRequest } from "./proxy";
import { Router } from "./router";

const config = loadConfig(process.argv[2]);
const router = new Router(config);

const server = Bun.serve({
  hostname: config.server.host,
  port: config.server.port,
  idleTimeout: config.server.timeoutSeconds,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/healthz" || url.pathname === "/health") {
      return Response.json({ status: "ok" });
    }
    if (url.pathname === "/status") {
      return new Response(JSON.stringify(router.getStatus(), null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    }
    return handleProxyRequest({ req, url, router, config });
  },
});

console.log(
  `\x1b[32m🚀 DeepSeek Latch Gateway running on http://${server.hostname}:${server.port}\x1b[0m`
);
for (const provider of Object.values(config.providers)) {
  console.log(`[Provider] ${provider.id} -> ${provider.baseUrl}`);
}
for (const [model, deployments] of Object.entries(config.models)) {
  console.log(`[Model] ${model}: ${deployments.map((d) => `${d.provider}(${d.model})`).join(" -> ")}`);
}

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
