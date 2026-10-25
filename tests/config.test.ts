import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseConfig } from "../src/config";
import { pinnedDeploymentProblem } from "../src/latest";

const example = readFileSync(join(import.meta.dir, "../config.example.yaml"), "utf-8");

describe("config", () => {
  it("parses providers, compat, extra_body and ordered model deployments", () => {
    process.env.TEST_KEY = "secret";
    const cfg = parseConfig(`
server: { port: 35002, timeout_seconds: 30 }
providers:
  cc:
    base_url: "https://cc.test/v1"
    api_key: "\${TEST_KEY}"
    compat: { strip_response_format: true, response_reasoning_field: reasoning, unwrap_error: true }
  or:
    base_url: "https://or.test/v1"
    extra_body: { provider: { sort: throughput } }
models:
  deepseek-flash:
    - { provider: cc, model: a }
    - { provider: or, model: b }
`);
    expect(cfg.server).toEqual({ host: "127.0.0.1", port: 35002, timeoutSeconds: 30 });
    expect(cfg.providers.cc).toEqual({
      id: "cc", baseUrl: "https://cc.test/v1", apiKey: "secret",
      compat: { stripResponseFormat: true, responseReasoningField: "reasoning", unwrapError: true },
    });
    expect(cfg.providers.or.extraBody).toEqual({ provider: { sort: "throughput" } });
    expect(cfg.models["deepseek-flash"]).toEqual([{ provider: "cc", model: "a" }, { provider: "or", model: "b" }]);
  });

  it("rejects missing sections, empty lists and unknown providers", () => {
    const providers = 'providers: { a: { base_url: "https://a.test/v1" } }\n';
    expect(() => parseConfig("models: { m: [] }")).toThrow("'providers'");
    expect(() => parseConfig(providers)).toThrow("'models'");
    expect(() => parseConfig(`${providers}models: { m: [] }`)).toThrow("non-empty");
    expect(() => parseConfig(`${providers}models: { m: [{ provider: b, model: x }] }`)).toThrow("unknown provider 'b'");
    expect(() => parseConfig(`${providers}models: { m: [{ provider: a }] }`)).toThrow("'provider' and 'model'");
    expect(() => parseConfig('providers: { a: { api_key: k } }\nmodels: { m: [{ provider: a, model: x }] }')).toThrow("base_url");
    const valid = `${providers}models: { m: [{ provider: a, model: x }] }\n`;
    expect(() => parseConfig(`server: { port: 0 }\n${valid}`)).toThrow("server.port");
    expect(() => parseConfig(`server: { timeout_seconds: 0 }\n${valid}`)).toThrow("timeout_seconds");
    expect(() => parseConfig(`server: { timeout_seconds: 256 }\n${valid}`)).toThrow("timeout_seconds");
  });

  it("rejects the old endpoints/routing.yaml format", () => {
    expect(() => parseConfig('endpoints:\n  - id: a\n    base_url: "https://a.test/v1"\n')).toThrow("'providers'");
  });

  it("ships only deepseek-flash and deepseek-pro, each ending on OpenRouter", () => {
    const cfg = parseConfig(example);
    expect(Object.keys(cfg.models)).toEqual(["deepseek-flash", "deepseek-pro"]);
    expect(cfg.models["deepseek-flash"].map((d) => d.provider)).toEqual([
      "opencode-go-1", "opencode-go-2", "opencode-go-3", "command-code", "openrouter",
    ]);
    expect(cfg.models["deepseek-pro"].map((d) => d.provider)).toEqual(["command-code", "openrouter"]);
  });

  it("ships every deployment pointed at the newest model, never a pinned snapshot", () => {
    const cfg = parseConfig(example);
    const deployments = Object.values(cfg.models).flat();
    expect(deployments.map(pinnedDeploymentProblem).filter(Boolean)).toEqual([]);
    expect(deployments.filter((d) => d.provider === "openrouter").map((d) => d.model)).toEqual([
      "~deepseek/deepseek-flash-latest", "~deepseek/deepseek-pro-latest",
    ]);
  });
});
