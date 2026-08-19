import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRoutingConfig, resolveRoute } from "../src/routing";
import { PriorityLatchManager } from "../src/priority-latch";
import type { GatewayConfig } from "../src/types";

function writeTempRouting(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "gw-routing-"));
  const path = join(dir, "routing.yaml");
  writeFileSync(path, yaml);
  return path;
}

function createConfig(): GatewayConfig {
  const endpoints = ["opencode-go-1", "opencode-go-2", "opencode-go-3", "command-code"].map(
    (id) => ({
      id,
      name: id,
      baseUrl: "http://127.0.0.1/v1",
      apiKey: `key-${id}`,
    })
  );

  return {
    server: { host: "127.0.0.1", port: 8080, timeoutSeconds: 30 },
    strategy: { mode: "latch", debounceSeconds: 0.01, maxRetriesPerRequest: 4 },
    endpoints,
    routing: {
      routes: {
        "deepseek-v4-flash": {
          mode: "priority-latch",
          groups: [
            {
              id: "opencode-go",
              priority: 1,
              mode: "latch",
              members: [
                { endpointId: "opencode-go-1" },
                { endpointId: "opencode-go-2" },
                { endpointId: "opencode-go-3" },
              ],
            },
            {
              id: "command-code-fallback",
              priority: 2,
              mode: "latch",
              members: [
                {
                  endpointId: "command-code",
                  upstreamModel: "deepseek/deepseek-v4-flash",
                },
              ],
            },
          ],
        },
      },
    },
  };
}

describe("routing config", () => {
  it("loads explicit priority groups and sorts by priority rather than YAML order", () => {
    const path = writeTempRouting(`
routes:
  deepseek-v4-flash:
    mode: priority-latch
    priority_groups:
      - id: command-code-fallback
        priority: 2
        mode: latch
        members:
          - endpoint: command-code
            upstream_model: deepseek/deepseek-v4-flash
      - id: opencode-go
        priority: 1
        mode: latch
        members:
          - endpoint: opencode-go-1
          - endpoint: opencode-go-2
          - endpoint: opencode-go-3
`);

    const routing = loadRoutingConfig(path);
    const route = resolveRoute(routing, "deepseek-v4-flash");

    expect(route.groups.map((group) => group.priority)).toEqual([1, 2]);
    expect(route.groups[0].members.map((member) => member.endpointId)).toEqual([
      "opencode-go-1",
      "opencode-go-2",
      "opencode-go-3",
    ]);
    expect(route.groups[1].members[0].upstreamModel).toBe("deepseek/deepseek-v4-flash");
  });
});

describe("PriorityLatchManager", () => {
  it("exhausts the three-key OpenCode latch before entering Command Code priority 2", () => {
    const manager = new PriorityLatchManager(createConfig());

    const first = manager.getAttempt("deepseek-v4-flash");
    expect(first?.endpoint.id).toBe("opencode-go-1");
    expect(first?.groupPriority).toBe(1);

    manager.advance("deepseek-v4-flash", first!, "429");
    expect(manager.getAttempt("deepseek-v4-flash")?.endpoint.id).toBe("opencode-go-2");

    const second = manager.getAttempt("deepseek-v4-flash");
    manager.advance("deepseek-v4-flash", second!, "429");
    expect(manager.getAttempt("deepseek-v4-flash")?.endpoint.id).toBe("opencode-go-3");

    const third = manager.getAttempt("deepseek-v4-flash");
    manager.advance("deepseek-v4-flash", third!, "429");
    const fallback = manager.getAttempt("deepseek-v4-flash");
    expect(fallback?.endpoint.id).toBe("command-code");
    expect(fallback?.groupPriority).toBe(2);
    expect(fallback?.upstreamModel).toBe("deepseek/deepseek-v4-flash");

    manager.recordSuccess("deepseek-v4-flash", fallback!);
    expect(manager.getAttempt("deepseek-v4-flash")?.endpoint.id).toBe("command-code");
  });
});
