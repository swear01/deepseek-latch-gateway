import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { ModelRouteConfig, RouteGroupConfig, RouteMemberConfig, RoutingConfig } from "./types";

interface RawRouteMember {
  endpoint?: string;
  endpointId?: string;
  endpoint_id?: string;
  upstreamModel?: string;
  upstream_model?: string;
}

interface RawRouteGroup {
  id?: string;
  priority?: number;
  mode?: "latch";
  members?: RawRouteMember[];
}

interface RawModelRoute {
  mode?: "priority-latch";
  priorityGroups?: RawRouteGroup[];
  priority_groups?: RawRouteGroup[];
}

interface RawRoutingConfig {
  routes?: Record<string, RawModelRoute>;
}

function parseMember(raw: RawRouteMember, routeModel: string, groupId: string, index: number): RouteMemberConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Invalid routing: route '${routeModel}' group '${groupId}' member ${index + 1} must be a mapping.`);
  }
  const endpointId = raw.endpointId ?? raw.endpoint_id ?? raw.endpoint;
  if (typeof endpointId !== "string" || !endpointId.trim()) {
    throw new Error(`Invalid routing: route '${routeModel}' group '${groupId}' member ${index + 1} needs an endpoint.`);
  }
  return {
    endpointId,
    upstreamModel: raw.upstreamModel || raw.upstream_model,
  };
}

function parseGroup(raw: RawRouteGroup, routeModel: string, index: number): RouteGroupConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Invalid routing: route '${routeModel}' group ${index + 1} must be a mapping.`);
  }
  const id = raw.id || `priority-${index + 1}`;
  if (raw.priority === undefined || !Number.isInteger(raw.priority) || raw.priority < 1) {
    throw new Error(`Invalid routing: route '${routeModel}' group '${id}' needs a positive integer priority.`);
  }
  if (raw.mode !== undefined && raw.mode !== "latch") {
    throw new Error(`Invalid routing: route '${routeModel}' group '${id}' mode must be 'latch'.`);
  }
  if (!Array.isArray(raw.members)) {
    throw new Error(`Invalid routing: route '${routeModel}' group '${id}' members must be an array.`);
  }
  const members = raw.members.map((member, memberIndex) =>
    parseMember(member, routeModel, id, memberIndex)
  );
  if (members.length === 0) {
    throw new Error(`Invalid routing: route '${routeModel}' group '${id}' needs at least one member.`);
  }
  return { id, priority: raw.priority, mode: "latch", members };
}

export function loadRoutingConfig(routingPath: string): RoutingConfig {
  if (!existsSync(routingPath)) {
    throw new Error(`Routing config not found: ${routingPath}`);
  }
  const parsed = (parseYaml(readFileSync(routingPath, "utf-8")) || {}) as RawRoutingConfig;
  if (!parsed.routes || typeof parsed.routes !== "object" || Array.isArray(parsed.routes) || Object.keys(parsed.routes).length === 0) {
    throw new Error("Invalid routing: 'routes' must be a mapping.");
  }

  const routes: Record<string, ModelRouteConfig> = Object.create(null);
  for (const [model, rawRoute] of Object.entries(parsed.routes)) {
    if (!rawRoute || typeof rawRoute !== "object" || Array.isArray(rawRoute)) {
      throw new Error(`Invalid routing: route '${model}' must be a mapping.`);
    }
    if (rawRoute.mode !== undefined && rawRoute.mode !== "priority-latch") {
      throw new Error(`Invalid routing: route '${model}' mode must be 'priority-latch'.`);
    }
    const rawGroups = rawRoute.priorityGroups ?? rawRoute.priority_groups ?? [];
    if (!Array.isArray(rawGroups)) {
      throw new Error(`Invalid routing: route '${model}' priority_groups must be an array.`);
    }
    const groups = rawGroups.map((group, index) => parseGroup(group, model, index));
    const priorities = new Set<number>();
    for (const group of groups) {
      if (priorities.has(group.priority)) {
        throw new Error(`Invalid routing: route '${model}' has duplicate priority ${group.priority}.`);
      }
      priorities.add(group.priority);
    }
    groups.sort((a, b) => a.priority - b.priority);
    if (groups.length === 0) {
      throw new Error(`Invalid routing: route '${model}' needs at least one priority group.`);
    }
    routes[model] = {
      mode: rawRoute.mode || "priority-latch",
      groups,
    };
  }
  return { routes };
}

export function validateRoutingConfig(routing: RoutingConfig, endpointIds: Iterable<string>): void {
  const knownEndpoints = new Set(endpointIds);
  for (const [model, route] of Object.entries(routing.routes)) {
    for (const group of route.groups) {
      for (const member of group.members) {
        if (!knownEndpoints.has(member.endpointId)) {
          throw new Error(
            `Invalid routing: route '${model}' group '${group.id}' references unknown endpoint '${member.endpointId}'.`
          );
        }
      }
    }
  }
}

export function resolveRoute(routing: RoutingConfig, model: string): ModelRouteConfig {
  const route = routing.routes[model];
  if (!Object.hasOwn(routing.routes, model)) {
    throw new Error(`No route configured for model '${model}'.`);
  }
  return route;
}
