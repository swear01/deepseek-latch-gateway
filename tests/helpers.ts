import { mock, spyOn } from "bun:test";
import { handleProxyRequest } from "../src/proxy";
import { Router } from "../src/router";
import type { GatewayConfig, ProviderConfig } from "../src/types";

export interface Call {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

export type Reply = Response | Error | ((call: Call) => Response | Error);

/** Replace global fetch: `replies[providerId]` is consumed in order; the last entry repeats. */
export function mockUpstreams(replies: Record<string, Reply[]>): Call[] {
  const calls: Call[] = [];
  const used = new Map<string, number>();
  const fake = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const provider = new URL(url).hostname.split(".")[0];
    const call = { url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body ?? "{}")) };
    calls.push(call);
    const list = replies[provider];
    if (!list) throw new Error(`unexpected upstream ${url}`);
    const index = used.get(provider) ?? 0;
    used.set(provider, index + 1);
    let reply = list[Math.min(index, list.length - 1)];
    if (typeof reply === "function") reply = reply(call);
    if (reply instanceof Error) throw reply;
    return reply.clone();
  };
  spyOn(globalThis, "fetch").mockImplementation(Object.assign(fake, { preconnect: globalThis.fetch.preconnect }));
  return calls;
}

export function restoreFetch(): void {
  mock.restore();
}

export function provider(id: string, extra: Partial<ProviderConfig> = {}): ProviderConfig {
  return { id, baseUrl: `https://${id}.test/v1`, apiKey: `key-${id}`, ...extra };
}

export function config(providers: ProviderConfig[], models?: GatewayConfig["models"]): GatewayConfig {
  return {
    server: { host: "127.0.0.1", port: 0, timeoutSeconds: 10 },
    providers: Object.fromEntries(providers.map((p) => [p.id, p])),
    models: models ?? { "deepseek-flash": providers.map((p) => ({ provider: p.id, model: `${p.id}-flash` })) },
  };
}

export function send(
  router: Router,
  cfg: GatewayConfig,
  body: Record<string, unknown> | string,
  headers: Record<string, string> = {},
  init: { method?: string; path?: string; signal?: AbortSignal } = {}
) {
  const method = init.method ?? "POST";
  const req = new Request(`http://127.0.0.1:8080${init.path ?? "/v1/chat/completions"}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: method === "GET" ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    signal: init.signal,
  });
  return handleProxyRequest({ req, url: new URL(req.url), router, config: cfg });
}

export function ok(body: Record<string, unknown> = { choices: [] }, headers: Record<string, string> = {}): Response {
  return Response.json(body, { headers });
}

export function status(code: number, body: unknown = { error: { message: `status ${code}` } }): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: code,
    headers: { "Content-Type": typeof body === "string" ? "text/html" : "application/json" },
  });
}
