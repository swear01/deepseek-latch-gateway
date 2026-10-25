import { createHash } from "node:crypto";
import { upstreamSnippet } from "./redact";
import { COOLDOWN_MS, type Router } from "./router";
import type { Deployment, GatewayConfig, ProviderConfig } from "./types";

interface ProxyRequestContext {
  req: Request;
  url: URL;
  router: Router;
  config: GatewayConfig;
}

/** The original call plus one same-provider retry for a transient network failure. */
const SAME_PROVIDER_ATTEMPTS = 2;
const DEFAULT_GATEWAY_USER_AGENT = "aisimpv-gateway/1.0";

function resolveUserAgent(rawUserAgent: string | null): string {
  if (!rawUserAgent) return DEFAULT_GATEWAY_USER_AGENT;
  const lower = rawUserAgent.toLowerCase();
  if (
    lower.startsWith("python-urllib") ||
    lower.startsWith("python-requests") ||
    lower.startsWith("aiohttp") ||
    lower.startsWith("httpx") ||
    lower.startsWith("urllib")
  ) {
    return DEFAULT_GATEWAY_USER_AGENT;
  }
  return rawUserAgent;
}

function isCloudflare1010OrWafBlock(status: number, bodyText: string): boolean {
  if (status !== 403) return false;
  const lower = bodyText.toLowerCase();
  return (
    lower.includes("error 1010") ||
    lower.includes("error code: 1010") ||
    (lower.includes("cloudflare") && (lower.includes("1010") || lower.includes("access denied")))
  );
}

function isQuotaError(status: number, bodyText: string): boolean {
  if (status === 429 || status === 402) return true;
  const lower = bodyText.toLowerCase();
  return (
    lower.includes("insufficient_quota") ||
    lower.includes("rate_limit_exceeded") ||
    lower.includes("quota exceeded") ||
    lower.includes("too many requests") ||
    lower.includes("usage limit reached") ||
    lower.includes("gousagelimiterror") ||
    lower.includes("usagelimiterror") ||
    lower.includes("weekly usage limit") ||
    lower.includes("regionerror") ||
    lower.includes("creditserror") ||
    lower.includes("insufficient balance") ||
    (status === 403 && lower.includes("an active opencode go subscription is required to use go models"))
  );
}

/**
 * The provider itself is unusable (quota, credentials, block, outage), so the
 * request moves to the next deployment. Other 4xx answers describe the client
 * request and are relayed unchanged.
 */
function isProviderFailure(status: number, bodyText: string): boolean {
  return (
    status === 401 ||
    status === 408 ||
    status >= 500 ||
    isQuotaError(status, bodyText) ||
    isCloudflare1010OrWafBlock(status, bodyText)
  );
}

function withoutQuery(url: string): string {
  const queryStart = url.indexOf("?");
  return queryStart === -1 ? url : `${url.slice(0, queryStart)}?[redacted]`;
}

function buildTargetUrl(baseUrl: string, pathWithQuery: string): string {
  const cleanBase = baseUrl.replace(/\/+$/, "");
  let cleanPath = pathWithQuery;
  if (cleanBase.endsWith("/v1") && cleanPath.startsWith("/v1")) {
    cleanPath = cleanPath.slice(3);
  }
  return `${cleanBase}${cleanPath}`;
}

function errorResponse(status: number, type: string, code: string, message: string, headers: Record<string, string> = {}): Response {
  return Response.json({ error: { message, type, code } }, { status, headers });
}

function buildUpstreamBody(body: Record<string, unknown>, provider: ProviderConfig, deployment: Deployment): string {
  const out: Record<string, unknown> = { ...body };
  for (const [key, value] of Object.entries(provider.extraBody ?? {})) {
    if (key === "model" || key === "response_format") continue;
    out[key] = value;
  }
  out.model = deployment.model;
  if (provider.compat?.stripResponseFormat) {
    // Upstream rejects the official response_format param (e.g. Command
    // Code 400 "Invalid input", OpenCode Go 400 "must contain the word json").
    delete out.response_format;
  }
  return JSON.stringify(out);
}

/** OpenCode Go needs a stable session id; derive it from the caller or the opening message. */
function openCodeSessionId(req: Request, body: Record<string, unknown>): string | undefined {
  const explicit = [
    "x-opencode-session",
    "x-deepseek-harness-session-id",
    "x-session-id",
    "x-session-affinity",
    "x-conversation-id",
    "session_id",
    "conversation_id",
  ]
    .map((name) => req.headers.get(name)?.trim()).find(Boolean);
  if (explicit) return explicit;
  const messages = Array.isArray(body.messages) ? body.messages : body.input;
  const opening = Array.isArray(messages)
    ? messages.find((message) => message?.role === "user")?.content
    : typeof messages === "string" ? messages : body.prompt;
  if (opening === undefined || opening === null) return undefined;
  // ponytail: identical openings share affinity; clients must send a session ID for exact isolation and compaction.
  return createHash("sha256").update(JSON.stringify([
    req.headers.get("authorization"), req.headers.get("x-deepseek-harness-user-id"), body.user, opening,
  ])).digest("hex");
}

function isOpenCode(targetUrl: string): boolean {
  const host = new URL(targetUrl).hostname;
  return host === "opencode.ai" || host.endsWith(".opencode.ai");
}

function buildUpstreamHeaders(req: Request, provider: ProviderConfig, sessionId?: string): Headers {
  const headers = new Headers();
  req.headers.forEach((val, key) => {
    const lowerKey = key.toLowerCase();
    if (lowerKey !== "host" && lowerKey !== "authorization" && lowerKey !== "content-length" && lowerKey !== "user-agent") {
      headers.set(key, val);
    }
  });
  headers.set("User-Agent", resolveUserAgent(req.headers.get("user-agent")));
  if (!headers.has("content-type")) headers.set("Content-Type", "application/json");
  headers.set("Authorization", `Bearer ${provider.apiKey}`);
  for (const [k, v] of Object.entries(provider.extraHeaders ?? {})) {
    headers.set(k, v);
  }
  if (sessionId) headers.set("x-opencode-session", sessionId);
  return headers;
}

function buildClientHeaders(upstreamRes: Response, deployment: Deployment, upstreamCalls: number): Headers {
  const responseHeaders = new Headers();
  upstreamRes.headers.forEach((val, key) => {
    const lowerKey = key.toLowerCase();
    if (lowerKey !== "content-encoding" && lowerKey !== "content-length" && lowerKey !== "transfer-encoding") {
      responseHeaders.set(key, val);
    }
  });
  responseHeaders.set("X-Gateway-Active-Endpoint", deployment.provider);
  responseHeaders.set("X-Gateway-Upstream-Model", deployment.model);
  responseHeaders.set("X-Gateway-Attempt", String(upstreamCalls));
  return responseHeaders;
}

/**
 * Upstream error body double-wrapped as `{"error":{"message":"<JSON>"}}`
 * (Command Code): parse the inner JSON out so the client sees the official
 * single-layer error shape. Anything unparseable passes through untouched.
 */
function unwrapErrorBody(bodyText: string): string {
  try {
    const outer = JSON.parse(bodyText) as { error?: { message?: unknown } };
    const message = outer?.error?.message;
    if (typeof message !== "string") return bodyText;
    const inner = JSON.parse(message) as { error?: unknown };
    if (inner && typeof inner === "object" && inner.error) {
      return JSON.stringify(inner);
    }
  } catch {
    // Not the double-wrapped shape: forward verbatim.
  }
  return bodyText;
}

/**
 * Rename an upstream's non-official reasoning field (e.g. `reasoning`) to the
 * official `reasoning_content` and drop its companion details field (e.g.
 * `reasoning_details`) inside every choice's message object.
 */
function rewriteReasoningInChoices(choices: unknown, field: string): boolean {
  if (!Array.isArray(choices)) return false;
  let changed = false;
  for (const choice of choices) {
    // Some upstreams include both `message` and `delta` on a single chunk:
    // rewrite whichever object carries the field.
    const messages = [choice?.message, choice?.delta].filter(
      (m): m is Record<string, unknown> => !!m && typeof m === "object"
    );
    for (const message of messages) {
      if (Object.prototype.hasOwnProperty.call(message, field)) {
        message.reasoning_content = message[field as keyof typeof message];
        delete message[field as keyof typeof message];
        changed = true;
      }
      const detailsField = `${field}_details`;
      if (Object.prototype.hasOwnProperty.call(message, detailsField)) {
        delete message[detailsField as keyof typeof message];
        changed = true;
      }
    }
  }
  return changed;
}

function rewriteJsonReasoningField(bodyText: string, field: string): string {
  try {
    const json = JSON.parse(bodyText) as { choices?: unknown };
    if (rewriteReasoningInChoices(json.choices, field)) {
      return JSON.stringify(json);
    }
  } catch {
    // Not JSON we can rewrite: forward verbatim.
  }
  return bodyText;
}

/**
 * SSE passthrough that rewrites reasoning field names inside each `data:`
 * JSON payload. Assumes each event's JSON sits on a single `data:` line
 * (verified empirically for Command Code and OpenCode Go); lines that fail to
 * parse are forwarded unchanged so a conversion error can never break the
 * stream, and `data: [DONE]` plus the event framing are untouched.
 */
function rewriteSseReasoningField(body: ReadableStream<Uint8Array>, field: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";
  const rewriteLine = (line: string): string => {
    const trimmed = line.replace(/\r$/, "");
    if (!trimmed.startsWith("data:")) return line;
    const payload = trimmed.slice(5).trim();
    if (!payload.startsWith("{")) return line;
    try {
      const json = JSON.parse(payload) as { choices?: unknown };
      if (rewriteReasoningInChoices(json.choices, field)) {
        return `data: ${JSON.stringify(json)}`;
      }
    } catch {
      // Unparseable data line (e.g. [DONE]): forward unchanged.
    }
    return line;
  };
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          controller.enqueue(encoder.encode(rewriteLine(line) + "\n"));
        }
      },
      flush(controller) {
        buffer += decoder.decode(); // release any trailing partial multi-byte sequence
        if (buffer.length > 0) {
          controller.enqueue(encoder.encode(rewriteLine(buffer) + "\n"));
        }
      },
    })
  );
}

/**
 * Body-consumption failure during response normalization: report a
 * deterministic 502 instead of retrying (a retry would issue a fresh upstream
 * LLM call for a response the provider already produced — duplicate billing).
 */
function upstreamBodyReadFailure(headers: Headers, err: unknown): Response {
  headers.set("Content-Type", "application/json");
  return new Response(
    JSON.stringify({
      error: {
        message: `Failed to read upstream response body: ${(err as Error)?.message || String(err)}`,
        type: "gateway_error",
        code: "upstream_body_read_failed",
      },
    }),
    { status: 502, headers }
  );
}

async function forwardUpstreamResponse(
  upstreamRes: Response,
  provider: ProviderConfig,
  deployment: Deployment,
  upstreamCalls: number
): Promise<Response> {
  const compat = provider.compat;
  const headers = buildClientHeaders(upstreamRes, deployment, upstreamCalls);
  const { status, statusText } = upstreamRes;

  // Compat bridges happen only when the provider declares a deviation;
  // otherwise the upstream body is streamed through zero-copy.
  if (compat?.unwrapError && !upstreamRes.ok) {
    let bodyText: string;
    try {
      bodyText = await upstreamRes.text();
    } catch (err) {
      return upstreamBodyReadFailure(headers, err);
    }
    headers.set("Content-Type", "application/json");
    return new Response(unwrapErrorBody(bodyText), { status, statusText, headers });
  }

  if (compat?.responseReasoningField && upstreamRes.ok) {
    const contentType = upstreamRes.headers.get("content-type") || "";
    const body = upstreamRes.body;
    if (body && contentType.includes("text/event-stream")) {
      return new Response(rewriteSseReasoningField(body, compat.responseReasoningField), { status, statusText, headers });
    }
    if (contentType.includes("application/json")) {
      let bodyText: string;
      try {
        bodyText = await upstreamRes.text();
      } catch (err) {
        return upstreamBodyReadFailure(headers, err);
      }
      return new Response(rewriteJsonReasoningField(bodyText, compat.responseReasoningField), { status, statusText, headers });
    }
  }

  return new Response(upstreamRes.body, { status, statusText, headers });
}

function listModels(config: GatewayConfig): Response {
  return Response.json({
    object: "list",
    data: Object.keys(config.models).map((id) => ({ id, object: "model", owned_by: "deepseek-latch-gateway" })),
  });
}

/** DeepSeek official chat completions accept only `response_format: {type: "json_object"}` or `null`. */
function responseFormatError(body: Record<string, unknown>): Response | undefined {
  const responseFormat = body.response_format;
  if (responseFormat === undefined || responseFormat === null) return undefined;
  if (typeof responseFormat === "object" && (responseFormat as { type?: unknown }).type === "json_object") return undefined;
  let receivedType: string;
  if (typeof responseFormat === "object") {
    const type = (responseFormat as { type?: unknown }).type;
    receivedType = type === undefined ? "<missing>" : JSON.stringify(type);
  } else {
    receivedType = typeof responseFormat;
  }
  return Response.json({
    error: {
      message: `response_format.type must be "json_object" (got ${receivedType}); json_schema is not part of the DeepSeek official contract this gateway exposes`,
      type: "invalid_request_error",
      param: "response_format",
      code: "invalid_request_error",
    },
  }, { status: 400 });
}

const COOLDOWN_MINUTES = COOLDOWN_MS / 60_000;

function retryAfterSeconds(router: Router, model: string): Record<string, string> {
  const remaining = router.remainingCooldownMs(model);
  return remaining === undefined ? {} : { "Retry-After": String(Math.max(1, Math.ceil(remaining / 1000))) };
}

export async function handleProxyRequest(ctx: ProxyRequestContext): Promise<Response> {
  const { req, url, router, config } = ctx;
  const pathWithQuery = url.pathname + url.search;

  if (req.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
    return listModels(config);
  }
  if (req.method !== "POST") {
    return errorResponse(405, "invalid_request_error", "method_not_allowed", `${req.method} is not supported; send POST with a JSON body.`);
  }

  let body: unknown;
  try {
    body = JSON.parse(await req.text());
  } catch {
    body = undefined;
  }
  if (!body || typeof body !== "object" || Array.isArray(body) || typeof (body as { model?: unknown }).model !== "string") {
    return errorResponse(400, "invalid_request_error", "missing_model", "Request body must be a JSON object with a string 'model'.");
  }
  const json = body as Record<string, unknown>;
  const model = router.resolveModel(json.model as string);
  if (!model) {
    const allowed = Object.keys(config.models).join(", ");
    console.warn(`[Model Rejected] ${json.model} (allowed: ${allowed} and their versioned aliases)`);
    return errorResponse(400, "invalid_request_error", "model_not_allowed",
      `Model not allowed: ${json.model}. Allowed models: ${allowed} (versioned names such as deepseek-v4-flash alias to them).`);
  }
  const formatError = responseFormatError(json);
  if (formatError) return formatError;

  const deployments = router.available(model);
  if (deployments.length === 0) {
    return errorResponse(503, "gateway_error", "no_available_provider",
      `Every provider for ${model} failed within the last ${COOLDOWN_MINUTES} minutes and is cooling down.`, retryAfterSeconds(router, model));
  }

  let upstreamCalls = 0;
  let attempted = false;
  for (const deployment of deployments) {
    const provider = config.providers[deployment.provider];
    const targetUrl = buildTargetUrl(provider.baseUrl, pathWithQuery);
    let sessionId: string | undefined;
    if (isOpenCode(targetUrl)) {
      sessionId = openCodeSessionId(req, json);
      if (!sessionId) continue;
    }
    attempted = true;
    const init = {
      method: "POST",
      headers: buildUpstreamHeaders(req, provider, sessionId),
      body: buildUpstreamBody(json, provider, deployment),
      signal: req.signal,
    };
    router.recordRequest(deployment);

    let failure = "";
    for (let attempt = 0; attempt < SAME_PROVIDER_ATTEMPTS; attempt++) {
      let upstreamRes: Response;
      try {
        upstreamCalls++;
        upstreamRes = await fetch(targetUrl, init);
      } catch (err: unknown) {
        if (req.signal.aborted) throw err;
        failure = (err as Error)?.message || String(err);
        console.error(`\x1b[31m[Fetch Error]\x1b[0m Failed to reach ${provider.id} (${withoutQuery(targetUrl)}): ${failure}`);
        continue;
      }
      if (!upstreamRes.ok) {
        let errBody = "";
        try {
          errBody = await upstreamRes.clone().text();
        } catch {
          // Unreadable error body: classify by status alone.
        }
        if (isProviderFailure(upstreamRes.status, errBody)) {
          void upstreamRes.body?.cancel().catch(() => {});
          failure = `Status ${upstreamRes.status}: ${upstreamSnippet(errBody, provider, 150)}`;
          break;
        }
      } else {
        router.recordSuccess(deployment);
      }
      return forwardUpstreamResponse(upstreamRes, provider, deployment, upstreamCalls);
    }
    router.recordFailure(deployment, failure);
  }

  if (!attempted) {
    return errorResponse(400, "invalid_request_error", "missing_session_id",
      "Send x-opencode-session with a stable conversation ID when no opening user message is available.");
  }
  return errorResponse(503, "gateway_error", "no_available_provider",
    `Every available provider for ${model} failed; each is paused for ${COOLDOWN_MINUTES} minutes.`,
    { ...retryAfterSeconds(router, model), "X-Gateway-Attempt": String(upstreamCalls) });
}
