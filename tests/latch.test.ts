import { describe, expect, it } from "bun:test";
import { RSLatchManager } from "../src/latch";
import type { GatewayConfig } from "../src/types";

function createMockConfig(count: number = 2, debounceSeconds: number = 0.5): GatewayConfig {
  const endpoints = Array.from({ length: count }, (_, i) => ({
    id: `endpoint-${i + 1}`,
    name: `Mock Endpoint ${i + 1}`,
    baseUrl: `http://127.0.0.1:900${i + 1}/v1`,
    apiKey: `mock-key-${i + 1}`,
  }));

  return {
    server: { host: "127.0.0.1", port: 8080, timeoutSeconds: 30 },
    strategy: { mode: "latch", debounceSeconds, maxRetriesPerRequest: count },
    endpoints,
  };
}

describe("RSLatchManager", () => {
  it("initializes at index 0 and returns active endpoint", () => {
    const config = createMockConfig(2);
    const latch = new RSLatchManager(config);

    expect(latch.getActiveIndex()).toBe(0);
    expect(latch.getActiveEndpoint().id).toBe("endpoint-1");
  });

  it("flips to Key 2 on 429 and stays on Key 2 (RS-Latch Ping-Pong)", () => {
    const config = createMockConfig(2, 0.01);
    const latch = new RSLatchManager(config);

    // Initial state: Key 1
    expect(latch.getActiveIndex()).toBe(0);

    // Key 1 encounters 429 -> Flip to Key 2
    const res1 = latch.trigger429(0, "HTTP 429 Quota Exceeded");
    expect(res1.switched).toBe(true);
    expect(res1.oldIndex).toBe(0);
    expect(res1.newIndex).toBe(1);
    expect(latch.getActiveIndex()).toBe(1);
    expect(latch.getActiveEndpoint().id).toBe("endpoint-2");

    // Subsequent normal requests remain on Key 2
    latch.recordRequest(1);
    latch.recordSuccess(1);
    expect(latch.getActiveIndex()).toBe(1);

    // Key 2 encounters 429 -> Flip back to Key 1 (Pong!)
    const res2 = latch.trigger429(1, "HTTP 429 Quota Exceeded");
    expect(res2.switched).toBe(true);
    expect(res2.oldIndex).toBe(1);
    expect(res2.newIndex).toBe(0);
    expect(latch.getActiveIndex()).toBe(0);
  });

  it("debounces rapid concurrent 429 triggers", async () => {
    const config = createMockConfig(3, 0.2); // 200ms debounce
    const latch = new RSLatchManager(config);

    expect(latch.getActiveIndex()).toBe(0);

    // First 429 triggers switch 0 -> 1
    const firstSwitch = latch.trigger429(0, "Rapid 429 #1");
    expect(firstSwitch.switched).toBe(true);
    expect(latch.getActiveIndex()).toBe(1);

    // Immediate second 429 from old index 0 is ignored
    const secondSwitchFromOld = latch.trigger429(0, "Rapid 429 #2");
    expect(secondSwitchFromOld.switched).toBe(false);
    expect(latch.getActiveIndex()).toBe(1);

    // Wait for debounce window to pass
    await new Promise((r) => setTimeout(r, 250));

    // Next 429 from index 1 switches 1 -> 2
    const thirdSwitch = latch.trigger429(1, "Subsequent 429");
    expect(thirdSwitch.switched).toBe(true);
    expect(latch.getActiveIndex()).toBe(2);
  });

  it("supports manual force switch", () => {
    const config = createMockConfig(3);
    const latch = new RSLatchManager(config);

    expect(latch.getActiveIndex()).toBe(0);

    latch.forceSwitch();
    expect(latch.getActiveIndex()).toBe(1);

    latch.forceSwitch(2);
    expect(latch.getActiveIndex()).toBe(2);

    latch.forceSwitch(0);
    expect(latch.getActiveIndex()).toBe(0);
  });

  it("advances on repeated network failures without polluting 429 stats", () => {
    const config = createMockConfig(2, 0.01);
    const latch = new RSLatchManager(config);

    expect(latch.getActiveIndex()).toBe(0);

    // Two consecutive network failures on the active endpoint advance the latch
    const res = latch.advanceOnNetworkFailure(0, "socket closed");
    expect(res.switched).toBe(true);
    expect(latch.getActiveIndex()).toBe(1);

    // No 429/quota accounting for network failures
    const status = latch.getStatus();
    expect(status.endpoints[0].errors429).toBe(0);
    expect(status.endpoints[0].last429Time).toBeUndefined();
    expect(status.totalSwitches).toBe(1);
    expect(status.lastSwitchReason).toContain("socket closed");

    // Debounce applies the same way as trigger429
    const debounced = latch.advanceOnNetworkFailure(1, "another socket error");
    expect(debounced.switched).toBe(true); // different index, no debounce for it
    latch.advanceOnNetworkFailure(0, "immediate repeat");
    const immediateRepeat = latch.advanceOnNetworkFailure(0, "still within window");
    expect(immediateRepeat.switched).toBe(false);
  });

  it("provides accurate status report", () => {
    const config = createMockConfig(2);
    const latch = new RSLatchManager(config);

    latch.recordRequest(0);
    latch.recordSuccess(0);
    latch.trigger429(0, "Rate limited");

    const status = latch.getStatus();
    expect(status.activeIndex).toBe(1);
    expect(status.totalRequests).toBe(1);
    expect(status.totalSwitches).toBe(1);
    expect(status.endpoints[0].requests).toBe(1);
    expect(status.endpoints[0].successCount).toBe(1);
    expect(status.endpoints[0].errors429).toBe(1);
  });
});
