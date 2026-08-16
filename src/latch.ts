import type { GatewayConfig, EndpointConfig, EndpointStats, GatewayStatus } from "./types";

export class RSLatchManager {
  private config: GatewayConfig;
  /** Cycling pool: endpoints WITHOUT a dedicated `models` list */
  private pool: EndpointConfig[];
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
    this.pool = config.endpoints.filter((ep) => !ep.models || ep.models.length === 0);
    if (this.pool.length === 0) {
      throw new Error("Invalid configuration: RS-Latch pool needs at least one endpoint without a dedicated `models` list.");
    }
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

  public getPoolSize(): number {
    return this.pool.length;
  }

  public getActiveIndex(): number {
    return this.activeIndex;
  }

  public getActiveEndpoint(): EndpointConfig {
    return this.pool[this.activeIndex];
  }

  public getEndpointByIndex(index: number): EndpointConfig {
    const idx = ((index % this.pool.length) + this.pool.length) % this.pool.length;
    return this.pool[idx];
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

  /** Stats-only recording for dedicated (non-pool) endpoints. */
  public recordRequestFor(endpointId: string): void {
    this.totalRequests++;
    const stat = this.stats.get(endpointId);
    if (stat) {
      stat.requests++;
    }
  }

  public recordSuccessFor(endpointId: string): void {
    const stat = this.stats.get(endpointId);
    if (stat) {
      stat.successCount++;
      stat.lastSuccessTime = new Date().toISOString();
    }
  }

  public record429For(endpointId: string, reason: string = "HTTP 429 Rate Limit"): void {
    const stat = this.stats.get(endpointId);
    if (stat) {
      stat.errors429++;
      stat.last429Time = new Date().toISOString();
    }
    console.warn(`[Dedicated 429] ${endpointId}: ${reason}`);
  }

  /**
   * Called when a pool endpoint returns 429 / Quota Exceeded.
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
    return this.advanceLatch(fromIndex, reason, now);
  }

  /**
   * Advance the latch away from an endpoint that failed repeatedly with
   * network/connectivity errors (NOT quota exhaustion). Flips exactly like
   * trigger429 (same debounce) but does not pollute the 429/quota stats.
   */
  public advanceOnNetworkFailure(
    fromIndex: number,
    reason: string = "Network/Fetch failure"
  ): { oldIndex: number; newIndex: number; switched: boolean } {
    return this.advanceLatch(fromIndex, reason, Date.now());
  }

  private advanceLatch(
    fromIndex: number,
    reason: string,
    now: number
  ): { oldIndex: number; newIndex: number; switched: boolean } {
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
    const newIndex = (oldIndex + 1) % this.pool.length;
    this.activeIndex = newIndex;
    this.lastSwitchTimestamp = now;
    this.lastIndexSwitchTimestamps.set(oldIndex, now);
    this.totalSwitches++;
    this.lastSwitchReason = `Switched from ${this.pool[oldIndex].name} to ${this.pool[newIndex].name} due to: ${reason}`;

    console.log(
      `\x1b[33m[RS-Latch FLIP]\x1b[0m ${this.lastSwitchReason} (Total switches: ${this.totalSwitches})`
    );

    return { oldIndex, newIndex, switched: true };
  }

  /**
   * Force switch the latch to a specific pool index or to the next pool index.
   */
  public forceSwitch(targetIndex?: number): { oldIndex: number; newIndex: number } {
    const oldIndex = this.activeIndex;
    if (targetIndex !== undefined) {
      this.activeIndex =
        ((targetIndex % this.pool.length) + this.pool.length) % this.pool.length;
    } else {
      this.activeIndex = (this.activeIndex + 1) % this.pool.length;
    }
    this.lastSwitchTimestamp = Date.now();
    this.totalSwitches++;
    this.lastSwitchReason = `Manual switch to index ${this.activeIndex} (${this.pool[this.activeIndex].name})`;

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
