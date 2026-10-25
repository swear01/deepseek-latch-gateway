import { unversionedModelId } from "./latest";
import type { Deployment, GatewayConfig } from "./types";

/** A failed deployment is not contacted again for this long, whatever the failure was. */
export const COOLDOWN_MS = 30 * 60 * 1000;

interface DeploymentState {
  requests: number;
  successes: number;
  failures: number;
  cooldownUntil?: number;
  lastError?: string;
  lastErrorTime?: string;
  lastSuccessTime?: string;
}

function keyOf(deployment: Deployment): string {
  return `${deployment.provider}/${deployment.model}`;
}

export class Router {
  private readonly states = new Map<string, DeploymentState>();
  private readonly startedAt: number;

  constructor(private readonly config: GatewayConfig, private readonly now: () => number = Date.now) {
    this.startedAt = now();
    for (const deployments of Object.values(config.models)) {
      for (const deployment of deployments) {
        this.states.set(keyOf(deployment), { requests: 0, successes: 0, failures: 0 });
      }
    }
  }

  /** Configured model id for an incoming name, accepting versioned and prefixed DeepSeek aliases. */
  resolveModel(model: string): string | undefined {
    if (Object.hasOwn(this.config.models, model)) return model;
    const alias = unversionedModelId(model);
    return alias && Object.hasOwn(this.config.models, alias) ? alias : undefined;
  }

  /** Deployments for `model` that are not cooling down, in configured order. */
  available(model: string): Deployment[] {
    const time = this.now();
    return this.config.models[model].filter((deployment) => {
      const until = this.state(deployment).cooldownUntil;
      return until === undefined || until <= time;
    });
  }

  /** Milliseconds until the first deployment of `model` leaves cooldown, if any is cooling down. */
  remainingCooldownMs(model: string): number | undefined {
    const time = this.now();
    const times = this.config.models[model]
      .map((deployment) => this.state(deployment).cooldownUntil)
      .filter((until): until is number => until !== undefined && until > time);
    return times.length > 0 ? Math.min(...times) - time : undefined;
  }

  recordRequest(deployment: Deployment): void {
    this.state(deployment).requests++;
  }

  recordSuccess(deployment: Deployment): void {
    const state = this.state(deployment);
    state.successes++;
    state.cooldownUntil = undefined;
    state.lastSuccessTime = new Date(this.now()).toISOString();
  }

  recordFailure(deployment: Deployment, reason: string): void {
    const state = this.state(deployment);
    const time = this.now();
    state.failures++;
    state.cooldownUntil = time + COOLDOWN_MS;
    state.lastError = reason.slice(0, 200);
    state.lastErrorTime = new Date(time).toISOString();
    console.warn(`[Cooldown] ${keyOf(deployment)} paused for ${COOLDOWN_MS / 60_000} minutes: ${state.lastError}`);
  }

  getStatus() {
    const time = this.now();
    return {
      uptime_seconds: Math.floor((time - this.startedAt) / 1000),
      models: Object.fromEntries(Object.entries(this.config.models).map(([model, deployments]) => [
        model,
        deployments.map((deployment) => {
          const state = this.state(deployment);
          return {
            provider: deployment.provider,
            model: deployment.model,
            requests: state.requests,
            successes: state.successes,
            failures: state.failures,
            cooling_down: state.cooldownUntil !== undefined && state.cooldownUntil > time,
            cooldown_until: state.cooldownUntil ? new Date(state.cooldownUntil).toISOString() : undefined,
            last_error: state.lastError,
            last_error_time: state.lastErrorTime,
            last_success_time: state.lastSuccessTime,
          };
        }),
      ])),
    };
  }

  private state(deployment: Deployment): DeploymentState {
    const state = this.states.get(keyOf(deployment));
    if (!state) throw new Error(`Unknown deployment: ${keyOf(deployment)}`);
    return state;
  }
}
