import { describe, expect, it } from "bun:test";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";

function writeTempConfig(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "gw-config-"));
  const path = join(dir, "config.yaml");
  writeFileSync(path, yaml);
  return path;
}

describe("Config compat parsing", () => {
  it("parses snake_case compat keys into the camelCase EndpointCompat shape", () => {
    const path = writeTempConfig(`
server:
  host: "127.0.0.1"
  port: 35001
strategy:
  mode: "latch"
endpoints:
  - id: "command-code"
    base_url: "https://api.commandcode.ai/provider/v1"
    api_key: "sk-test"
    compat:
      strip_response_format: true
      response_reasoning_field: "reasoning"
      unwrap_error: true
  - id: "opencode-go-1"
    base_url: "https://opencode.ai/zen/go/v1"
    api_key: "sk-test-2"
    compat:
      strip_response_format: true
  - id: "deepseek-official"
    base_url: "https://api.deepseek.com/v1"
    api_key: "sk-test-3"
models:
  allow: ["deepseek-v4-flash", "deepseek-v4-pro"]
`);

    const config = loadConfig(path);
    const byId = new Map(config.endpoints.map((ep) => [ep.id, ep]));

    expect(byId.get("command-code")!.compat).toEqual({
      stripResponseFormat: true,
      responseReasoningField: "reasoning",
      unwrapError: true,
    });
    expect(byId.get("opencode-go-1")!.compat).toEqual({ stripResponseFormat: true });
    // No compat declared = full official passthrough
    expect(byId.get("deepseek-official")!.compat).toBeUndefined();
  });

  it("accepts camelCase compat keys as well", () => {
    const path = writeTempConfig(`
server:
  host: "127.0.0.1"
  port: 35001
strategy:
  mode: "latch"
endpoints:
  - id: "ep"
    base_url: "https://example.com/v1"
    api_key: "sk"
    compat:
      stripResponseFormat: false
      responseReasoningField: "thinking"
      unwrapError: false
models:
  allow: ["deepseek-v4-flash"]
`);

    const config = loadConfig(path);
    expect(config.endpoints[0].compat).toEqual({
      stripResponseFormat: false,
      responseReasoningField: "thinking",
      unwrapError: false,
    });
  });
});
