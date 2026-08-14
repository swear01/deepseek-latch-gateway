import { readFileSync, existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { GatewayConfig, EndpointConfig } from "./types";

function interpolateEnv(str: string): string {
  return str.replace(/\$\{([^}]+)\}/g, (_, key) => {
    const val = process.env[key];
    if (val === undefined) {
      console.warn(`[Config] Warning: Environment variable '${key}' is not defined.`);
      return "";
    }
    return val;
  });
}

function resolveEndpoint(endpoint: EndpointConfig): EndpointConfig {
  return {
    ...endpoint,
    baseUrl: interpolateEnv(endpoint.baseUrl),
    apiKey: interpolateEnv(endpoint.apiKey),
    name: endpoint.name ? interpolateEnv(endpoint.name) : endpoint.id,
  };
}

export function loadConfig(configPath?: string): GatewayConfig {
  const defaultPath = process.env.GATEWAY_CONFIG || "./config.yaml";
  const targetPath = configPath || defaultPath;

  let rawContent = "";
  if (existsSync(targetPath)) {
    rawContent = readFileSync(targetPath, "utf-8");
  } else {
    // If no config file found, fallback to env-based default
    console.log(`[Config] No config file found at ${targetPath}, checking environment variables...`);
    const key1 = process.env.OPENCODE_GO_KEY_1 || process.env.OPENCODE_API_KEY || "";
    const key2 = process.env.OPENCODE_GO_KEY_2 || "";

    const endpoints: EndpointConfig[] = [];
    if (key1) {
      endpoints.push({
        id: "opencode-go-1",
        name: "OpenCode Go (Account 1)",
        baseUrl: process.env.OPENCODE_BASE_URL || "https://opencode.ai/zen/go/v1",
        apiKey: key1,
      });
    }
    if (key2) {
      endpoints.push({
        id: "opencode-go-2",
        name: "OpenCode Go (Account 2)",
        baseUrl: process.env.OPENCODE_BASE_URL || "https://opencode.ai/zen/go/v1",
        apiKey: key2,
      });
    }

    if (endpoints.length === 0) {
      throw new Error("No endpoints configured. Provide a config.yaml or OPENCODE_GO_KEY_1 environment variable.");
    }

    return {
      server: {
        host: process.env.HOST || "127.0.0.1",
        port: parseInt(process.env.PORT || "8080", 10),
        timeoutSeconds: 120,
      },
      strategy: {
        mode: "latch",
        debounceSeconds: 1.0,
        maxRetriesPerRequest: endpoints.length,
      },
      endpoints,
    };
  }

  const parsed = parseYaml(rawContent) as Partial<GatewayConfig>;

  const config: GatewayConfig = {
    server: {
      host: parsed.server?.host || "127.0.0.1",
      port: parsed.server?.port || 8080,
      timeoutSeconds: parsed.server?.timeoutSeconds || 120,
    },
    strategy: {
      mode: parsed.strategy?.mode || "latch",
      debounceSeconds: parsed.strategy?.debounceSeconds ?? 1.0,
      maxRetriesPerRequest: parsed.strategy?.maxRetriesPerRequest || (parsed.endpoints?.length ?? 2),
    },
    endpoints: (parsed.endpoints || []).map(resolveEndpoint),
    models: parsed.models || { aliases: {} },
  };

  if (config.endpoints.length === 0) {
    throw new Error("Invalid configuration: 'endpoints' array must contain at least one endpoint.");
  }

  return config;
}
