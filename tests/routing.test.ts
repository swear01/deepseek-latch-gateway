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
  it("rejects malformed routing shapes with configuration errors", () => {
    const group = { priority: 1, members: [{ endpoint: "go" }] };
    for (const routes of [
      {}, [], { flash: null }, { flash: 3 }, { flash: { priority_groups: {} } },
      { flash: { priority_groups: [null] } },
      { flash: { priority_groups: [{ ...group, members: {} }] } },
      { flash: { priority_groups: [{ ...group, members: [null] }] } },
      { flash: { priority_groups: [{ ...group, members: [{ endpoint: 123 }] }] } },
      { flash: { priority_groups: [{ ...group, id: 123 }] } },
      { flash: { priority_groups: [{ ...group, id: "same" }, { ...group, id: " same ", priority: 2 }] } },
      { flash: { priority_groups: [group], priorityGroups: [] } },
      { flash: { priority_groups: [{ ...group, members: [{ endpoint: "go", upstream_model: 123 }] }] } },
    ]) {
      expect(() => loadRoutingConfig(writeTempRouting(JSON.stringify({ routes })))).toThrow("Invalid routing:");
    }
  });

  it("normalizes member names and group IDs", () => {
    const routing = loadRoutingConfig(writeTempRouting(JSON.stringify({ routes: { flash: {
      priority_groups: [{ id: " go ", priority: 1, members: [{ endpoint: " key ", upstream_model: " model " }] }],
    } } })));
    expect(routing.routes.flash.groups[0]).toEqual({ id: "go", priority: 1, mode: "latch", members: [{ endpointId: "key", upstreamModel: "model" }] });
  });

  it("treats special model names as own data properties", () => {
    const route = { priority_groups: [{ priority: 1, members: [{ endpoint: "go" }] }] };
    const routing = loadRoutingConfig(writeTempRouting(JSON.stringify({ routes: { ["__proto__"]: route, constructor: route } })));
    expect(Object.keys(routing.routes)).toEqual(["__proto__", "constructor"]);
    expect(resolveRoute(routing, "__proto__").groups[0].members[0].endpointId).toBe("go");
    expect(() => resolveRoute({ routes: {} }, "toString")).toThrow("No route configured");
  });

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

    manager.record429("deepseek-v4-flash", first!);
    manager.advance("deepseek-v4-flash", first!, "429");
    expect(manager.getAttempt("deepseek-v4-flash")?.endpoint.id).toBe("opencode-go-2");

    const second = manager.getAttempt("deepseek-v4-flash");
    manager.record429("deepseek-v4-flash", second!);
    manager.advance("deepseek-v4-flash", second!, "429");
    expect(manager.getAttempt("deepseek-v4-flash")?.endpoint.id).toBe("opencode-go-3");

    const third = manager.getAttempt("deepseek-v4-flash");
    manager.record429("deepseek-v4-flash", third!);
    manager.advance("deepseek-v4-flash", third!, "429");
    const fallback = manager.getAttempt("deepseek-v4-flash");
    expect(fallback?.endpoint.id).toBe("command-code");
    expect(fallback?.groupPriority).toBe(2);
    expect(fallback?.upstreamModel).toBe("deepseek/deepseek-v4-flash");

    manager.recordSuccess("deepseek-v4-flash", fallback!);
    expect(manager.getAttempt("deepseek-v4-flash")?.endpoint.id).toBe("command-code");
  });

  it("half-opens the higher-priority group after 1.5 hours for one request", () => {
    let now = 0;
    const manager = new PriorityLatchManager(createConfig(), () => now);
    const model = "deepseek-v4-flash";

    for (let index = 0; index < 3; index++) {
      const attempt = manager.getAttempt(model);
      manager.record429(model, attempt!);
      manager.advance(model, attempt!, "429");
    }

    now = 90 * 60 * 1000 - 1;
    expect(manager.getAttempt(model)?.endpoint.id).toBe("command-code");

    now++;
    const probeRequest = new Set<string>();
    expect(manager.getAttempt(model, probeRequest)?.endpoint.id).toBe("opencode-go-1");
    expect(manager.getAttempt(model, new Set())?.endpoint.id).toBe("command-code");
    expect(manager.getStatus().endpoints.find((endpoint) => endpoint.id === "opencode-go-1")).toMatchObject({
      circuitState: "half-open",
      consecutiveFailures: 1,
      blockedUntil: "1970-01-01T01:30:00.000Z",
    });

    const probe = manager.getAttempt(model, probeRequest);
    manager.recordSuccess(model, probe!);
    expect(manager.getAttempt(model)?.endpoint.id).toBe("opencode-go-1");
    expect(manager.getStatus().endpoints.find((endpoint) => endpoint.id === "opencode-go-1")).toMatchObject({
      circuitState: "closed",
      consecutiveFailures: 0,
      blockedUntil: undefined,
    });
  });

  it("doubles the cooldown after a failed half-open recovery", () => {
    let now = 0;
    const manager = new PriorityLatchManager(createConfig(), () => now);
    const model = "deepseek-v4-flash";

    for (let index = 0; index < 3; index++) {
      const attempt = manager.getAttempt(model);
      manager.record429(model, attempt!);
      manager.advance(model, attempt!, "429");
    }

    now = 90 * 60 * 1000;
    const probeRequest = new Set<string>();
    for (let index = 0; index < 3; index++) {
      const attempt = manager.getAttempt(model, probeRequest);
      manager.record429(model, attempt!);
      manager.advance(model, attempt!, "429");
    }

    now += 3 * 60 * 60 * 1000 - 1;
    expect(manager.getAttempt(model)?.endpoint.id).toBe("command-code");
    now++;
    expect(manager.getAttempt(model, new Set())?.endpoint.id).toBe("opencode-go-1");
  });

  it("clears the selected endpoint circuit on a manual switch", () => {
    const manager = new PriorityLatchManager(createConfig());
    const model = "deepseek-v4-flash";

    const first = manager.getAttempt(model)!;
    manager.record429(model, first);
    manager.advance(model, first, "429");
    manager.forceSwitch(0);

    expect(manager.getAttempt(model)?.endpoint.id).toBe("opencode-go-1");
    expect(manager.getStatus().endpoints.find((endpoint) => endpoint.id === "opencode-go-1")).toMatchObject({
      circuitState: "closed",
      consecutiveFailures: 0,
      blockedUntil: undefined,
    });
  });
});
