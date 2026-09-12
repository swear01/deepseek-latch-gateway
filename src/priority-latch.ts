import type {
  EndpointConfig,
  EndpointStats,
  GatewayConfig,
  GatewayStatus,
  ModelRouteConfig,
} from "./types";
import { validateRoutingConfig } from "./routing";

export interface PriorityRouteAttempt {
  key: string;
  model: string;
  groupId: string;
  groupPriority: number;
  groupIndex: number;
  memberIndex: number;
  endpoint: EndpointConfig;
  upstreamModel?: string;
}

interface RouteState {
  route: ModelRouteConfig;
  activeGroupIndex: number;
  activeMemberIndexes: number[];
  recoveryProbeOwner?: Set<string>;
  recoveryFallbackGroupIndex?: number;
}

interface EndpointCircuit {
  consecutiveFailures: number;
  blockedUntil: number;
}

const QUOTA_COOLDOWN_MS = 90 * 60 * 1000;
const MAX_QUOTA_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const NETWORK_COOLDOWN_MS = 30 * 1000;
const MAX_NETWORK_COOLDOWN_MS = 15 * 60 * 1000;

export class PriorityLatchManager {
  private readonly endpoints: Map<string, EndpointConfig>;
  private readonly routes: Map<string, RouteState> = new Map();
  private readonly stats: Map<string, EndpointStats> = new Map();
  private readonly circuits: Map<string, EndpointCircuit> = new Map();
  private readonly now: () => number;
  private readonly startTime: number;
  private lastSwitchTimestamp = 0;
  private totalSwitches = 0;
  private totalRequests = 0;
  private lastSwitchReason = "";

  constructor(config: GatewayConfig, now: () => number = Date.now) {
    if (!config.routing) {
      throw new Error("Invalid configuration: priority routing requires a routing config.");
    }
    this.now = now;
    this.startTime = now();
    this.endpoints = new Map(config.endpoints.map((endpoint) => [endpoint.id, endpoint]));
    validateRoutingConfig(config.routing, this.endpoints.keys());
    for (const [model, route] of Object.entries(config.routing.routes)) {
      this.routes.set(model, {
        route,
        activeGroupIndex: 0,
        activeMemberIndexes: route.groups.map(() => 0),
      });
    }
    for (const endpoint of config.endpoints) {
      this.circuits.set(endpoint.id, { consecutiveFailures: 0, blockedUntil: 0 });
      this.stats.set(endpoint.id, {
        id: endpoint.id,
        name: endpoint.name,
        requests: 0,
        successCount: 0,
        errors429: 0,
      });
    }
  }

  public hasRoute(model: string): boolean {
    return this.routes.has(model);
  }

  public getDefaultModel(): string {
    const model = this.routes.keys().next().value;
    if (!model) throw new Error("Invalid routing: no model routes configured.");
    return model;
  }

  public getRouteSize(model: string): number {
    const state = this.getState(model);
    return state.route.groups.reduce((total, group) => total + group.members.length, 0);
  }

  public getAttempt(model: string, excluded: Set<string> = new Set()): PriorityRouteAttempt | undefined {
    const state = this.getState(model);
    const now = this.now();
    if (state.recoveryProbeOwner && state.recoveryProbeOwner !== excluded) {
      return this.findAttempt(
        model,
        state,
        state.recoveryFallbackGroupIndex!,
        excluded,
        now
      );
    }
    let attempt: PriorityRouteAttempt | undefined;
    if (!state.recoveryProbeOwner && state.activeGroupIndex > 0) {
      const fallbackGroupIndex = state.activeGroupIndex;
      const recovered = this.findAttempt(model, state, 0, excluded, now, fallbackGroupIndex, false);
      if (recovered) {
        state.recoveryProbeOwner = excluded;
        state.recoveryFallbackGroupIndex = fallbackGroupIndex;
        state.activeGroupIndex = recovered.groupIndex;
        state.activeMemberIndexes[recovered.groupIndex] = recovered.memberIndex;
        return recovered;
      }
    }
    attempt = this.findAttempt(model, state, state.activeGroupIndex, excluded, now);
    return attempt ?? this.findAttempt(model, state, 0, excluded, now, state.route.groups.length, false, true);
  }

  private findAttempt(
    model: string,
    state: RouteState,
    startGroupIndex: number,
    excluded: Set<string>,
    now: number,
    endGroupIndex = state.route.groups.length,
    useActiveMember = true,
    ignoreCircuit = false
  ): PriorityRouteAttempt | undefined {
    for (let groupIndex = startGroupIndex; groupIndex < endGroupIndex; groupIndex++) {
      const group = state.route.groups[groupIndex];
      const firstMember = useActiveMember && groupIndex === startGroupIndex
        ? state.activeMemberIndexes[groupIndex]
        : 0;
      for (let memberIndex = firstMember; memberIndex < group.members.length; memberIndex++) {
        const attempt = this.createAttempt(model, state, groupIndex, memberIndex);
        const circuit = this.circuits.get(attempt.endpoint.id)!;
        if (!excluded.has(attempt.key) && (ignoreCircuit || circuit.blockedUntil <= now)) return attempt;
      }
    }
    return undefined;
  }

  public recordRequest(_model: string, attempt: PriorityRouteAttempt): void {
    this.totalRequests++;
    const stat = this.stats.get(attempt.endpoint.id);
    if (stat) stat.requests++;
  }

  public recordSuccess(model: string, attempt: PriorityRouteAttempt): void {
    const stat = this.stats.get(attempt.endpoint.id);
    if (stat) {
      stat.successCount++;
      stat.lastSuccessTime = new Date(this.now()).toISOString();
    }
    const circuit = this.circuits.get(attempt.endpoint.id);
    if (circuit) {
      circuit.consecutiveFailures = 0;
      circuit.blockedUntil = 0;
    }
    const state = this.getState(model);
    if (!state.recoveryProbeOwner || state.activeGroupIndex === attempt.groupIndex) {
      state.activeGroupIndex = attempt.groupIndex;
      state.activeMemberIndexes[attempt.groupIndex] = attempt.memberIndex;
      state.recoveryProbeOwner = undefined;
      state.recoveryFallbackGroupIndex = undefined;
    }
  }

  public record429(_model: string, attempt: PriorityRouteAttempt, retryAfterMs?: number): void {
    const stat = this.stats.get(attempt.endpoint.id);
    if (stat) {
      stat.errors429++;
      stat.last429Time = new Date(this.now()).toISOString();
    }
    this.openCircuit(attempt.endpoint.id, QUOTA_COOLDOWN_MS, MAX_QUOTA_COOLDOWN_MS, retryAfterMs);
  }

  public recordNetworkFailure(_model: string, attempt: PriorityRouteAttempt): void {
    this.openCircuit(attempt.endpoint.id, NETWORK_COOLDOWN_MS, MAX_NETWORK_COOLDOWN_MS);
  }

  public isRecoveryProbe(model: string, attempt: PriorityRouteAttempt): boolean {
    const state = this.getState(model);
    return Boolean(
      state.recoveryProbeOwner &&
      state.activeGroupIndex === attempt.groupIndex &&
      state.activeMemberIndexes[attempt.groupIndex] === attempt.memberIndex
    );
  }

  public finishRequest(model: string, owner: Set<string>): void {
    const state = this.getState(model);
    if (state.recoveryProbeOwner !== owner) return;
    state.activeGroupIndex = state.recoveryFallbackGroupIndex!;
    state.recoveryProbeOwner = undefined;
    state.recoveryFallbackGroupIndex = undefined;
  }

  public advance(
    model: string,
    attempt: PriorityRouteAttempt,
    reason: string
  ): { switched: boolean; groupExhausted: boolean; routeExhausted: boolean } {
    const state = this.getState(model);
    if (
      state.activeGroupIndex !== attempt.groupIndex ||
      state.activeMemberIndexes[attempt.groupIndex] !== attempt.memberIndex
    ) {
      return { switched: false, groupExhausted: false, routeExhausted: false };
    }

    const group = state.route.groups[attempt.groupIndex];
    const nextMember = attempt.memberIndex + 1;
    if (nextMember < group.members.length) {
      state.activeMemberIndexes[attempt.groupIndex] = nextMember;
      this.recordSwitch(attempt, state.route.groups[attempt.groupIndex].members[nextMember].endpointId, reason);
      return { switched: true, groupExhausted: false, routeExhausted: false };
    }

    const nextGroup = attempt.groupIndex + 1;
    if (nextGroup < state.route.groups.length) {
      state.activeGroupIndex = nextGroup;
      state.activeMemberIndexes[nextGroup] = 0;
      state.recoveryProbeOwner = undefined;
      state.recoveryFallbackGroupIndex = undefined;
      const next = state.route.groups[nextGroup];
      this.recordSwitch(attempt, next.members[0].endpointId, reason);
      return { switched: true, groupExhausted: true, routeExhausted: false };
    }

    this.lastSwitchReason = `Route '${model}' exhausted after ${attempt.endpoint.name}: ${reason}`;
    return { switched: false, groupExhausted: true, routeExhausted: true };
  }

  public getActiveIndex(): number {
    return this.getActiveAttemptForDefault().memberIndex;
  }

  public getActiveEndpoint(): EndpointConfig {
    return this.getActiveAttemptForDefault().endpoint;
  }

  public getActiveRouteInfo(): { priority: number; group: string } {
    const attempt = this.getActiveAttemptForDefault();
    return { priority: attempt.groupPriority, group: attempt.groupId };
  }

  public getPoolSize(): number {
    return this.getRouteSize(this.getDefaultModel());
  }

  public getEndpointByIndex(index: number): EndpointConfig {
    const state = this.getState(this.getDefaultModel());
    const members = state.route.groups.flatMap((group) => group.members);
    const normalized = ((index % members.length) + members.length) % members.length;
    return this.endpoints.get(members[normalized].endpointId)!;
  }

  public recordRequestFor(endpointId: string): void {
    this.totalRequests++;
    const stat = this.stats.get(endpointId);
    if (stat) stat.requests++;
  }

  public recordSuccessFor(endpointId: string): void {
    const stat = this.stats.get(endpointId);
    if (stat) {
      stat.successCount++;
      stat.lastSuccessTime = new Date(this.now()).toISOString();
    }
  }

  public record429For(endpointId: string, reason = "HTTP 429 Rate Limit"): void {
    const stat = this.stats.get(endpointId);
    if (stat) {
      stat.errors429++;
      stat.last429Time = new Date(this.now()).toISOString();
    }
    this.lastSwitchReason = `${endpointId}: ${reason}`;
  }

  public trigger429(index: number, reason = "HTTP 429 Rate Limit"): { oldIndex: number; newIndex: number; switched: boolean } {
    const oldAttempt = this.getAttemptByFlatIndex(this.getDefaultModel(), index);
    const result = this.advance(this.getDefaultModel(), oldAttempt, reason);
    return {
      oldIndex: index,
      newIndex: result.switched ? this.getActiveIndex() : index,
      switched: result.switched,
    };
  }

  public advanceOnNetworkFailure(index: number, reason = "Network/Fetch failure") {
    const attempt = this.getAttemptByFlatIndex(this.getDefaultModel(), index);
    this.recordNetworkFailure(this.getDefaultModel(), attempt);
    const result = this.advance(this.getDefaultModel(), attempt, reason);
    return {
      oldIndex: index,
      newIndex: result.switched ? this.getActiveIndex() : index,
      switched: result.switched,
    };
  }

  public forceSwitch(targetIndex?: number): { oldIndex: number; newIndex: number } {
    const model = this.getDefaultModel();
    const state = this.getState(model);
    const current = this.getActiveAttemptForDefault();
    const flattened = state.route.groups.flatMap((group, groupIndex) =>
      group.members.map((_, memberIndex) => ({ groupIndex, memberIndex }))
    );
    const oldIndex = flattened.findIndex(
      ({ groupIndex, memberIndex }) =>
        groupIndex === current.groupIndex && memberIndex === current.memberIndex
    );
    const newIndex = targetIndex === undefined
      ? (oldIndex + 1) % flattened.length
      : ((targetIndex % flattened.length) + flattened.length) % flattened.length;
    const target = flattened[newIndex];
    state.activeGroupIndex = target.groupIndex;
    state.activeMemberIndexes[target.groupIndex] = target.memberIndex;
    state.recoveryProbeOwner = undefined;
    state.recoveryFallbackGroupIndex = undefined;
    const endpoint = this.createAttempt(model, state, target.groupIndex, target.memberIndex).endpoint;
    const circuit = this.circuits.get(endpoint.id)!;
    circuit.consecutiveFailures = 0;
    circuit.blockedUntil = 0;
    this.lastSwitchTimestamp = this.now();
    this.totalSwitches++;
    this.lastSwitchReason = `Manual switch to index ${newIndex} (${this.getActiveEndpoint().name})`;
    return { oldIndex, newIndex };
  }

  public getStatus(): GatewayStatus {
    const active = this.getActiveAttemptForDefault();
    const routeInfo = this.getActiveRouteInfo();
    const halfOpenEndpoints = new Set<string>();
    for (const [model, state] of this.routes) {
      if (state.recoveryProbeOwner) {
        halfOpenEndpoints.add(this.createAttempt(
          model,
          state,
          state.activeGroupIndex,
          state.activeMemberIndexes[state.activeGroupIndex]
        ).endpoint.id);
      }
    }
    return {
      uptimeSeconds: Math.floor((this.now() - this.startTime) / 1000),
      activeIndex: active.memberIndex,
      activeEndpoint: {
        id: active.endpoint.id,
        name: active.endpoint.name,
        baseUrl: active.endpoint.baseUrl,
      },
      activePriority: routeInfo.priority,
      activeGroup: routeInfo.group,
      totalRequests: this.totalRequests,
      totalSwitches: this.totalSwitches,
      lastSwitchTime: this.lastSwitchTimestamp > 0 ? new Date(this.lastSwitchTimestamp).toISOString() : undefined,
      lastSwitchReason: this.lastSwitchReason || undefined,
      endpoints: Array.from(this.stats.values()).map((stat) => {
        const circuit = this.circuits.get(stat.id)!;
        return {
          ...stat,
          circuitState: halfOpenEndpoints.has(stat.id)
            ? "half-open"
            : circuit.consecutiveFailures > 0 ? "open" : "closed",
          consecutiveFailures: circuit.consecutiveFailures,
          blockedUntil: circuit.blockedUntil > 0 ? new Date(circuit.blockedUntil).toISOString() : undefined,
        };
      }),
    };
  }

  private getState(model: string): RouteState {
    const state = this.routes.get(model);
    if (!state) throw new Error(`No route configured for model '${model}'.`);
    return state;
  }

  private createAttempt(
    model: string,
    state: RouteState,
    groupIndex: number,
    memberIndex: number
  ): PriorityRouteAttempt {
    const group = state.route.groups[groupIndex];
    const member = group.members[memberIndex];
    const endpoint = this.endpoints.get(member.endpointId);
    if (!endpoint) throw new Error(`Unknown endpoint '${member.endpointId}'.`);
    return {
      key: `${model}:${group.id}:${memberIndex}:${member.endpointId}`,
      model,
      groupId: group.id,
      groupPriority: group.priority,
      groupIndex,
      memberIndex,
      endpoint,
      upstreamModel: member.upstreamModel,
    };
  }

  private getActiveAttemptForDefault(): PriorityRouteAttempt {
    const model = this.getDefaultModel();
    const state = this.getState(model);
    return this.createAttempt(
      model,
      state,
      state.activeGroupIndex,
      state.activeMemberIndexes[state.activeGroupIndex]
    );
  }

  private openCircuit(
    endpointId: string,
    baseCooldownMs: number,
    maxCooldownMs: number,
    retryAfterMs?: number
  ): void {
    const circuit = this.circuits.get(endpointId);
    if (!circuit) return;
    const now = this.now();
    if (circuit.blockedUntil > now) return;
    circuit.consecutiveFailures++;
    const exponentialCooldown = Math.min(
      baseCooldownMs * 2 ** (circuit.consecutiveFailures - 1),
      maxCooldownMs
    );
    circuit.blockedUntil = now + Math.min(retryAfterMs ?? exponentialCooldown, exponentialCooldown);
  }

  private getAttemptByFlatIndex(model: string, index: number): PriorityRouteAttempt {
    const state = this.getState(model);
    const members = state.route.groups.flatMap((group, groupIndex) =>
      group.members.map((_, memberIndex) => ({ groupIndex, memberIndex }))
    );
    const normalized = ((index % members.length) + members.length) % members.length;
    const target = members[normalized];
    return this.createAttempt(model, state, target.groupIndex, target.memberIndex);
  }

  private recordSwitch(attempt: PriorityRouteAttempt, nextEndpointId: string, reason: string): void {
    this.lastSwitchTimestamp = this.now();
    this.totalSwitches++;
    const nextEndpoint = this.endpoints.get(nextEndpointId);
    this.lastSwitchReason = `Switched from ${attempt.endpoint.name} to ${nextEndpoint?.name || nextEndpointId} due to: ${reason}`;
  }
}
