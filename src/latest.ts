import type { Deployment, GatewayConfig, ProviderConfig } from "./types";

export interface ModelName {
  family: "flash" | "pro";
  version: number[];
  snapshot?: string;
}

/** `deepseek/deepseek-v4.1-flash-1017` -> flash, [4, 1], "1017". Variants such as `-fast` or `-vision-exp` do not parse. */
export function parseModelName(id: string): ModelName | undefined {
  const match = /^(?:deepseek\/)?deepseek-v(\d+(?:\.\d+)*)-(flash|pro)(?:-(\d{4}|\d{8}))?$/.exec(id);
  if (!match) return undefined;
  return {
    family: match[2] as ModelName["family"],
    version: match[1].split(".").map(Number),
    snapshot: match[3],
  };
}

/** OpenRouter alias that always resolves to the newest snapshot, e.g. `~deepseek/deepseek-flash-latest`. */
export function latestAliasFamily(id: string): ModelName["family"] | undefined {
  const match = /^~deepseek\/deepseek-(flash|pro)-latest$/.exec(id);
  return match ? (match[1] as ModelName["family"]) : undefined;
}

export function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Static rule: a deployment names a moving "latest" target, never a pinned snapshot. */
export function pinnedDeploymentProblem(deployment: Deployment): string | undefined {
  if (latestAliasFamily(deployment.model)) return undefined;
  const parsed = parseModelName(deployment.model);
  if (!parsed) return `${deployment.provider}: '${deployment.model}' is neither a DeepSeek flash/pro model nor a latest alias`;
  if (parsed.snapshot) return `${deployment.provider}: '${deployment.model}' pins snapshot ${parsed.snapshot}`;
  return undefined;
}

export interface CatalogModel {
  id: string;
  created?: number;
}

/** Newest catalog entry for a family: highest version, then most recently created. */
export function newestInCatalog(catalog: CatalogModel[], family: ModelName["family"]): CatalogModel | undefined {
  let best: { model: CatalogModel; name: ModelName } | undefined;
  for (const model of catalog) {
    const name = parseModelName(model.id);
    if (!name || name.family !== family) continue;
    if (
      !best ||
      compareVersions(name.version, best.name.version) > 0 ||
      (compareVersions(name.version, best.name.version) === 0 && (model.created ?? 0) > (best.model.created ?? 0))
    ) {
      best = { model, name };
    }
  }
  return best?.model;
}

/** Live problem for one undated deployment: the provider lists a newer version of the same family. */
export function staleDeploymentProblem(deployment: Deployment, catalog: CatalogModel[]): string | undefined {
  const configured = parseModelName(deployment.model);
  if (!configured) return undefined;
  if (!catalog.some((model) => model.id === deployment.model)) {
    return `${deployment.provider}: '${deployment.model}' is not in the provider's model list`;
  }
  const newest = newestInCatalog(catalog.filter((model) => !parseModelName(model.id)?.snapshot), configured.family);
  if (newest && compareVersions(parseModelName(newest.id)!.version, configured.version) > 0) {
    return `${deployment.provider}: '${deployment.model}' is older than '${newest.id}'`;
  }
  return undefined;
}

async function fetchCatalog(providers: ProviderConfig[]): Promise<CatalogModel[]> {
  const errors: string[] = [];
  for (const provider of providers) {
    const res = await fetch(`${provider.baseUrl.replace(/\/+$/, "")}/models`, {
      headers: { Authorization: `Bearer ${provider.apiKey}`, ...provider.extraHeaders },
    });
    if (res.ok) {
      const body = (await res.json()) as { data?: CatalogModel[] };
      return body.data ?? [];
    }
    errors.push(`${provider.id}: HTTP ${res.status}`);
  }
  throw new Error(`cannot list models (${errors.join(", ")})`);
}

async function servedModel(provider: ProviderConfig, model: string): Promise<string> {
  const res = await fetch(`${provider.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${provider.apiKey}`, "Content-Type": "application/json", ...provider.extraHeaders },
    body: JSON.stringify({ ...provider.extraBody, model, max_tokens: 1, messages: [{ role: "user", content: "OK" }] }),
  });
  const body = (await res.json()) as { model?: string };
  if (!res.ok || typeof body.model !== "string") {
    throw new Error(`HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  }
  return body.model;
}

/** Check every deployment against its provider's live catalog; returns one line per problem. */
export async function checkLatest(config: GatewayConfig): Promise<string[]> {
  const problems: string[] = [];
  const catalogs = new Map<string, Promise<CatalogModel[]>>();
  const providersByUrl = new Map<string, ProviderConfig[]>();
  for (const provider of Object.values(config.providers)) {
    providersByUrl.set(provider.baseUrl, [...(providersByUrl.get(provider.baseUrl) ?? []), provider]);
  }
  const catalogFor = (provider: ProviderConfig) => {
    if (!catalogs.has(provider.baseUrl)) catalogs.set(provider.baseUrl, fetchCatalog(providersByUrl.get(provider.baseUrl)!));
    return catalogs.get(provider.baseUrl)!;
  };

  for (const [name, deployments] of Object.entries(config.models)) {
    for (const deployment of deployments) {
      const label = `${name} -> ${deployment.provider}`;
      const pinned = pinnedDeploymentProblem(deployment);
      if (pinned) {
        problems.push(`${name}: ${pinned}`);
        continue;
      }
      const provider = config.providers[deployment.provider];
      try {
        const catalog = await catalogFor(provider);
        const family = latestAliasFamily(deployment.model);
        if (family) {
          const newest = newestInCatalog(catalog, family);
          const served = await servedModel(provider, deployment.model);
          if (!newest || served !== newest.id) {
            problems.push(`${name}: ${deployment.provider}: '${deployment.model}' served '${served}', newest listed is '${newest?.id}'`);
          } else {
            console.log(`ok  ${label}: ${deployment.model} serves ${served}`);
          }
          continue;
        }
        const stale = staleDeploymentProblem(deployment, catalog);
        if (stale) problems.push(`${name}: ${stale}`);
        else console.log(`ok  ${label}: ${deployment.model} is the newest listed`);
      } catch (err) {
        problems.push(`${name}: ${deployment.provider}: ${(err as Error).message}`);
      }
    }
  }
  return problems;
}
