import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { Deployment, GatewayConfig, ProviderConfig } from "./types";

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

interface RawProviderConfig {
  base_url?: string;
  api_key?: string;
  compat?: {
    strip_response_format?: boolean;
    response_reasoning_field?: string;
    unwrap_error?: boolean;
  };
  extra_headers?: Record<string, string>;
  extra_body?: Record<string, unknown>;
}

interface RawGatewayConfig {
  server?: { host?: string; port?: number; timeout_seconds?: number };
  providers?: Record<string, RawProviderConfig>;
  models?: Record<string, Array<{ provider?: string; model?: string }>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function resolveProvider(id: string, raw: RawProviderConfig): ProviderConfig {
  if (!raw || typeof raw !== "object" || typeof raw.base_url !== "string" || !raw.base_url) {
    throw new Error(`Invalid configuration: providers.${id}.base_url is required.`);
  }
  if (raw.api_key !== undefined && typeof raw.api_key !== "string") {
    throw new Error(`Invalid configuration: providers.${id}.api_key must be a string.`);
  }
  const baseUrl = interpolateEnv(raw.base_url);
  if (!baseUrl) {
    throw new Error(`Invalid configuration: providers.${id}.base_url resolved to an empty string.`);
  }
  const provider: ProviderConfig = {
    id,
    baseUrl,
    apiKey: interpolateEnv(raw.api_key),
  };
  if (raw.compat) {
    provider.compat = {
      stripResponseFormat: raw.compat.strip_response_format,
      responseReasoningField: raw.compat.response_reasoning_field,
      unwrapError: raw.compat.unwrap_error,
    };
  }
  if (raw.extra_headers) provider.extraHeaders = raw.extra_headers;
  if (raw.extra_body) provider.extraBody = raw.extra_body;
  return provider;
}

export function parseConfig(rawContent: string): GatewayConfig {
  const parsed = (parseYaml(rawContent) || {}) as RawGatewayConfig;
  if (!isRecord(parsed.providers) || Object.keys(parsed.providers).length === 0) {
    throw new Error("Invalid configuration: 'providers' must map provider ids to settings.");
  }
  if (!isRecord(parsed.models) || Object.keys(parsed.models).length === 0) {
    throw new Error("Invalid configuration: 'models' must map public model ids to deployment lists.");
  }

  const providers: Record<string, ProviderConfig> = Object.create(null);
  for (const [id, raw] of Object.entries(parsed.providers)) {
    providers[id] = resolveProvider(id, raw);
  }

  const models: Record<string, Deployment[]> = Object.create(null);
  for (const [name, list] of Object.entries(parsed.models)) {
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error(`Invalid configuration: models.${name} must be a non-empty list.`);
    }
    models[name] = list.map((entry, index) => {
      if (!isRecord(entry) || typeof entry.provider !== "string" || typeof entry.model !== "string" || !entry.model) {
        throw new Error(`Invalid configuration: models.${name}[${index}] needs 'provider' and 'model'.`);
      }
      if (!Object.hasOwn(providers, entry.provider)) {
        throw new Error(`Invalid configuration: models.${name}[${index}] references unknown provider '${entry.provider}'.`);
      }
      return { provider: entry.provider, model: entry.model };
    });
  }

  return {
    server: {
      host: parsed.server?.host || "127.0.0.1",
      port: parsed.server?.port ?? 35001,
      timeoutSeconds: parsed.server?.timeout_seconds ?? 120,
    },
    providers,
    models,
  };
}

export function loadConfig(configPath?: string): GatewayConfig {
  const targetPath = configPath || process.env.GATEWAY_CONFIG || "./config.yaml";
  let rawContent: string;
  try {
    rawContent = readFileSync(targetPath, "utf-8");
  } catch {
    throw new Error(`Cannot read gateway config at '${targetPath}'. Copy config.example.yaml or pass the config path.`);
  }
  return parseConfig(rawContent);
}
