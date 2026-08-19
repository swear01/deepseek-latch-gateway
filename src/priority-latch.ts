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
}

export class PriorityLatchManager {
  private readonly endpoints: Map<string, EndpointConfig>;
  private readonly routes: Map<string, RouteState> = new Map();
  private readonly stats: Map<string, EndpointStats> = new Map();
  private readonly startTime = Date.now();
  private lastSwitchTimestamp = 0;
  private totalSwitches = 0;
  private totalRequests = 0;
  private lastSwitchReason = "";

  constructor(config: GatewayConfig) {
    if (!config.routing) {
      throw new Error("Invalid configuration: priority routing requires a routing config.");
    }
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
    for (let groupIndex = state.activeGroupIndex; groupIndex < state.route.groups.length; groupIndex++) {
      const group = state.route.groups[groupIndex];
      const firstMember = groupIndex === state.activeGroupIndex ? state.activeMemberIndexes[groupIndex] : 0;
      for (let memberIndex = firstMember; memberIndex < group.members.length; memberIndex++) {
        const attempt = this.createAttempt(model, state, groupIndex, memberIndex);
        if (!excluded.has(attempt.key)) return attempt;
      }
    }
    return undefined;
  }

  public recordRequest(_model: string, attempt: PriorityRouteAttempt): void {
    this.totalRequests++;
    const stat = this.stats.get(attempt.endpoint.id);
    if (stat) stat.requests++;
  }

  public recordSuccess(_model: string, attempt: PriorityRouteAttempt): void {
    const stat = this.stats.get(attempt.endpoint.id);
    if (stat) {
      stat.successCount++;
      stat.lastSuccessTime = new Date().toISOString();
    }
  }

  public record429(_model: string, attempt: PriorityRouteAttempt): void {
    const stat = this.stats.get(attempt.endpoint.id);
    if (stat) {
      stat.errors429++;
      stat.last429Time = new Date().toISOString();
    }
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
      stat.lastSuccessTime = new Date().toISOString();
    }
  }

  public record429For(endpointId: string, reason = "HTTP 429 Rate Limit"): void {
    const stat = this.stats.get(endpointId);
    if (stat) {
      stat.errors429++;
      stat.last429Time = new Date().toISOString();
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
    return this.trigger429(index, reason);
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
    this.lastSwitchTimestamp = Date.now();
    this.totalSwitches++;
    this.lastSwitchReason = `Manual switch to index ${newIndex} (${this.getActiveEndpoint().name})`;
    return { oldIndex, newIndex };
  }

  public getStatus(): GatewayStatus {
    const active = this.getActiveAttemptForDefault();
    const routeInfo = this.getActiveRouteInfo();
    return {
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
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
      endpoints: Array.from(this.stats.values()),
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
    this.lastSwitchTimestamp = Date.now();
    this.totalSwitches++;
    const nextEndpoint = this.endpoints.get(nextEndpointId);
    this.lastSwitchReason = `Switched from ${attempt.endpoint.name} to ${nextEndpoint?.name || nextEndpointId} due to: ${reason}`;
  }
}
