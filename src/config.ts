import { readFileSync, existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { GatewayConfig, EndpointConfig } from "./types";

function interpolateEnv(str?: string): string {
  if (!str) return "";
  return str.replace(/\$\{([^}]+)\}/g, (_, key) => {
    const val = process.env[key];
    if (val === undefined) {
      console.warn(`[Config] Warning: Environment variable '${key}' is not defined.`);
      return "";
    }
    return val;
  });
}

interface RawCompatConfig {
  stripResponseFormat?: boolean;
  strip_response_format?: boolean;
  responseReasoningField?: string;
  response_reasoning_field?: string;
  unwrapError?: boolean;
  unwrap_error?: boolean;
}

interface RawEndpointConfig {
  id?: string;
  name?: string;
  baseUrl?: string;
  base_url?: string;
  apiKey?: string;
  api_key?: string;
  weight?: number;
  models?: string[];
  modelMap?: Record<string, string>;
  model_map?: Record<string, string>;
  compat?: RawCompatConfig;
}

interface RawGatewayConfig {
  server?: {
    host?: string;
    port?: number;
    timeoutSeconds?: number;
    timeout_seconds?: number;
  };
  strategy?: {
    mode?: "latch";
    debounceSeconds?: number;
    debounce_seconds?: number;
    maxRetriesPerRequest?: number;
    max_retries_per_request?: number;
  };
  endpoints?: RawEndpointConfig[];
  models?: {
    aliases?: Record<string, string>;
    allow?: string[];
  };
}

function resolveCompat(raw?: RawCompatConfig): EndpointConfig["compat"] {
  if (!raw) return undefined;
  const compat: NonNullable<EndpointConfig["compat"]> = {};
  const stripResponseFormat = raw.stripResponseFormat ?? raw.strip_response_format;
  if (stripResponseFormat !== undefined) compat.stripResponseFormat = stripResponseFormat;
  const responseReasoningField = raw.responseReasoningField ?? raw.response_reasoning_field;
  if (responseReasoningField !== undefined) compat.responseReasoningField = responseReasoningField;
  const unwrapError = raw.unwrapError ?? raw.unwrap_error;
  if (unwrapError !== undefined) compat.unwrapError = unwrapError;
  return Object.keys(compat).length > 0 ? compat : undefined;
}

function resolveEndpoint(raw: RawEndpointConfig, index: number): EndpointConfig {
  const id = raw.id || `endpoint-${index + 1}`;
  const rawBaseUrl = raw.baseUrl || raw.base_url || "https://opencode.ai/zen/go/v1";
  const rawApiKey = raw.apiKey || raw.api_key || "";
  return {
    id,
    name: raw.name ? interpolateEnv(raw.name) : id,
    baseUrl: interpolateEnv(rawBaseUrl),
    apiKey: interpolateEnv(rawApiKey),
    weight: raw.weight,
    models: raw.models,
    modelMap: raw.modelMap || raw.model_map,
    compat: resolveCompat(raw.compat),
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
    const key1 = process.env.OPENCODE_API_KEY_1 || "";
    const key2 = process.env.OPENCODE_API_KEY_2 || "";

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
      throw new Error(
        "No endpoints configured. Provide a config.yaml or OPENCODE_API_KEY_1 environment variable."
      );
    }

    return {
      server: {
        host: process.env.HOST || "127.0.0.1",
        port: parseInt(process.env.PORT || "35001", 10),
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

  const parsed = (parseYaml(rawContent) || {}) as RawGatewayConfig;

  const endpoints = (parsed.endpoints || []).map(resolveEndpoint);
  if (endpoints.length === 0) {
    throw new Error("Invalid configuration: 'endpoints' array must contain at least one endpoint.");
  }

  const config: GatewayConfig = {
    server: {
      host: parsed.server?.host || "127.0.0.1",
      port: parsed.server?.port || 35001,
      timeoutSeconds: parsed.server?.timeoutSeconds || parsed.server?.timeout_seconds || 120,
    },
    strategy: {
      mode: parsed.strategy?.mode || "latch",
      debounceSeconds: parsed.strategy?.debounceSeconds ?? parsed.strategy?.debounce_seconds ?? 1.0,
      maxRetriesPerRequest:
        parsed.strategy?.maxRetriesPerRequest ||
        parsed.strategy?.max_retries_per_request ||
        endpoints.length,
    },
    endpoints,
    models: parsed.models || { aliases: {} },
  };

  return config;
}
