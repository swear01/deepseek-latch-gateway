import type { GatewayConfig, EndpointConfig, EndpointStats, GatewayStatus } from "./types";

export class RSLatchManager {
  private config: GatewayConfig;
  private activeIndex: number = 0;
  private lastSwitchTimestamp: number = 0;
  private lastIndexSwitchTimestamps: Map<number, number> = new Map();
  private totalSwitches: number = 0;
  private totalRequests: number = 0;
  private lastSwitchReason: string = "";
  private startTime: number = Date.now();
  private stats: Map<string, EndpointStats> = new Map();

  constructor(config: GatewayConfig) {
    this.config = config;
    for (const ep of config.endpoints) {
      this.stats.set(ep.id, {
        id: ep.id,
        name: ep.name,
        requests: 0,
        successCount: 0,
        errors429: 0,
      });
    }
  }

  public getActiveIndex(): number {
    return this.activeIndex;
  }

  public getActiveEndpoint(): EndpointConfig {
    return this.config.endpoints[this.activeIndex];
  }

  public getEndpointByIndex(index: number): EndpointConfig {
    const idx = ((index % this.config.endpoints.length) + this.config.endpoints.length) % this.config.endpoints.length;
    return this.config.endpoints[idx];
  }

  public recordRequest(endpointIndex: number): void {
    this.totalRequests++;
    const ep = this.getEndpointByIndex(endpointIndex);
    const stat = this.stats.get(ep.id);
    if (stat) {
      stat.requests++;
    }
  }

  public recordSuccess(endpointIndex: number): void {
    const ep = this.getEndpointByIndex(endpointIndex);
    const stat = this.stats.get(ep.id);
    if (stat) {
      stat.successCount++;
      stat.lastSuccessTime = new Date().toISOString();
    }
  }

  /**
   * Called when an endpoint returns 429 / Quota Exceeded.
   * Flips the RS Latch to the next available endpoint.
   * Debounced per-index to prevent concurrent requests on the same index from multi-flipping.
   */
  public trigger429(
    fromIndex: number,
    reason: string = "HTTP 429 Rate Limit"
  ): { oldIndex: number; newIndex: number; switched: boolean } {
    const now = Date.now();
    const ep = this.getEndpointByIndex(fromIndex);
    const stat = this.stats.get(ep.id);
    if (stat) {
      stat.errors429++;
      stat.last429Time = new Date().toISOString();
    }

    // 1. If activeIndex has already moved past fromIndex, do not switch again
    if (this.activeIndex !== fromIndex) {
      return { oldIndex: fromIndex, newIndex: this.activeIndex, switched: false };
    }

    // 2. Check per-index debounce window
    const debounceMs = this.config.strategy.debounceSeconds * 1000;
    const lastSwitchFromThis = this.lastIndexSwitchTimestamps.get(fromIndex) || 0;
    if (now - lastSwitchFromThis < debounceMs && lastSwitchFromThis > 0) {
      return { oldIndex: fromIndex, newIndex: this.activeIndex, switched: false };
    }

    // Advance Latch to next index (RS Latch Ping-Pong flip)
    const oldIndex = this.activeIndex;
    const newIndex = (oldIndex + 1) % this.config.endpoints.length;
    this.activeIndex = newIndex;
    this.lastSwitchTimestamp = now;
    this.lastIndexSwitchTimestamps.set(oldIndex, now);
    this.totalSwitches++;
    this.lastSwitchReason = `Switched from ${this.config.endpoints[oldIndex].name} to ${this.config.endpoints[newIndex].name} due to: ${reason}`;

    console.log(
      `\x1b[33m[RS-Latch FLIP]\x1b[0m ${this.lastSwitchReason} (Total switches: ${this.totalSwitches})`
    );

    return { oldIndex, newIndex, switched: true };
  }

  /**
   * Force switch the latch to a specific index or to the next index.
   */
  public forceSwitch(targetIndex?: number): { oldIndex: number; newIndex: number } {
    const oldIndex = this.activeIndex;
    if (targetIndex !== undefined) {
      this.activeIndex =
        ((targetIndex % this.config.endpoints.length) + this.config.endpoints.length) %
        this.config.endpoints.length;
    } else {
      this.activeIndex = (this.activeIndex + 1) % this.config.endpoints.length;
    }
    this.lastSwitchTimestamp = Date.now();
    this.totalSwitches++;
    this.lastSwitchReason = `Manual switch to index ${this.activeIndex} (${this.config.endpoints[this.activeIndex].name})`;

    console.log(`\x1b[36m[RS-Latch MANUAL]\x1b[0m ${this.lastSwitchReason}`);
    return { oldIndex, newIndex: this.activeIndex };
  }

  public getStatus(): GatewayStatus {
    const activeEp = this.getActiveEndpoint();
    return {
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
      activeIndex: this.activeIndex,
      activeEndpoint: {
        id: activeEp.id,
        name: activeEp.name,
        baseUrl: activeEp.baseUrl,
      },
      totalRequests: this.totalRequests,
      totalSwitches: this.totalSwitches,
      lastSwitchTime: this.lastSwitchTimestamp > 0 ? new Date(this.lastSwitchTimestamp).toISOString() : undefined,
      lastSwitchReason: this.lastSwitchReason || undefined,
      endpoints: Array.from(this.stats.values()),
    };
  }
}
