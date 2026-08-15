import type { GatewayConfig, EndpointConfig } from "./types";
import type { RSLatchManager } from "./latch";

interface ProxyRequestContext {
  req: Request;
  url: URL;
  latch: RSLatchManager;
  config: GatewayConfig;
}

function isRateLimitOrQuotaError(status: number, bodyText: string): boolean {
  if (status === 429 || status === 402) {
    return true;
  }
  const lower = bodyText.toLowerCase();
  if (
    lower.includes("insufficient_quota") ||
    lower.includes("rate_limit_exceeded") ||
    lower.includes("quota exceeded") ||
    lower.includes("too many requests") ||
    lower.includes("usage limit reached") ||
    lower.includes("gousagelimiterror") ||
    lower.includes("usagelimiterror") ||
    lower.includes("weekly usage limit") ||
    lower.includes("regionerror")
  ) {
    return true;
  }
  return false;
}

function parseRequestBody(bodyText: string): { json: Record<string, unknown>; model?: string } | null {
  if (!bodyText) return null;
  try {
    const json = JSON.parse(bodyText);
    if (json && typeof json === "object" && typeof json.model === "string") {
      return { json, model: json.model };
    }
    return { json };
  } catch {
    return null;
  }
}

function rewriteRequestBody(bodyText: string, config: GatewayConfig): string {
  if (!config.models?.aliases || Object.keys(config.models.aliases).length === 0) {
    return bodyText;
  }
  const parsed = parseRequestBody(bodyText);
  if (!parsed) return bodyText;
  const alias = config.models.aliases[parsed.model || ""];
  if (alias && alias !== parsed.model) {
    parsed.json.model = alias;
    return JSON.stringify(parsed.json);
  }
  return bodyText;
}

async function forwardToEndpoint(
  endpoint: EndpointConfig,
  req: Request,
  targetUrl: string,
  method: string,
  bodyText: string,
  modelMap?: Record<string, string>
): Promise<Response> {
  let finalBodyText = bodyText;
  if (modelMap && Object.keys(modelMap).length > 0) {
    const parsed = parseRequestBody(bodyText);
    if (parsed && parsed.model && modelMap[parsed.model]) {
      parsed.json.model = modelMap[parsed.model];
      finalBodyText = JSON.stringify(parsed.json);
    }
  }

  const headers = new Headers();
  req.headers.forEach((val, key) => {
    const lowerKey = key.toLowerCase();
    // Drop hop-by-hop headers and host
    if (lowerKey !== "host" && lowerKey !== "authorization" && lowerKey !== "content-length") {
      headers.set(key, val);
    }
  });

  headers.set("Authorization", `Bearer ${endpoint.apiKey}`);
  if (endpoint.extraHeaders) {
    for (const [k, v] of Object.entries(endpoint.extraHeaders)) {
      headers.set(k, v);
    }
  }

  return fetch(targetUrl, {
    method,
    headers,
    body: method !== "GET" && method !== "HEAD" ? finalBodyText : undefined,
    signal: req.signal,
  });
}

function buildTargetUrl(baseUrl: string, pathWithQuery: string): string {
  let cleanBase = baseUrl.replace(/\/+$/, "");
  let cleanPath = pathWithQuery;
  if (cleanBase.endsWith("/v1") && cleanPath.startsWith("/v1")) {
    cleanPath = cleanPath.slice(3);
  }
  return `${cleanBase}${cleanPath}`;
}

function forwardUpstreamResponse(upstreamRes: Response, endpointId: string, attempt: number): Response {
  const responseHeaders = new Headers();
  upstreamRes.headers.forEach((val, key) => {
    const lowerKey = key.toLowerCase();
    if (lowerKey !== "content-encoding" && lowerKey !== "content-length" && lowerKey !== "transfer-encoding") {
      responseHeaders.set(key, val);
    }
  });
  responseHeaders.set("X-Gateway-Active-Endpoint", endpointId);
  responseHeaders.set("X-Gateway-Attempt", String(attempt));
  return new Response(upstreamRes.body, {
    status: upstreamRes.status,
    statusText: upstreamRes.statusText,
    headers: responseHeaders,
  });
}

export async function handleProxyRequest(ctx: ProxyRequestContext): Promise<Response> {
  const { req, url, latch, config } = ctx;
  const method = req.method;
  const pathWithQuery = url.pathname + url.search;

  // Read request body once so we can replay/retry if needed
  let rawBodyText = "";
  if (method !== "GET" && method !== "HEAD") {
    rawBodyText = await req.text();
  }

  const originalModel = parseRequestBody(rawBodyText)?.model;

  // --- Model allowlist ---------------------------------------------------------
  // Checked against the original (pre-alias) model: unknown models are rejected
  // outright instead of being aliased or forwarded.
  if (originalModel && config.models?.allow && config.models.allow.length > 0) {
    if (!config.models.allow.includes(originalModel)) {
      const allowed = config.models.allow.join(", ");
      console.warn(`[Model Rejected] ${originalModel} (allowed: ${allowed})`);
      return new Response(
        JSON.stringify({
          error: {
            message: `Model not allowed: ${originalModel}. Allowed models: ${allowed}`,
            type: "invalid_request_error",
            code: "model_not_allowed",
          },
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }
  }

  const finalBodyText = rewriteRequestBody(rawBodyText, config);
  const requestModel = parseRequestBody(finalBodyText)?.model;

  // --- Model-based dedicated routing -------------------------------------------
  // An endpoint declaring `models` handles those incoming models exclusively
  // (bypasses the RS-Latch pool). Others fall through to the latch pool below.
  if (requestModel) {
    const dedicated = config.endpoints.find((ep) => ep.models?.includes(requestModel));
    if (dedicated) {
      const targetUrl = buildTargetUrl(dedicated.baseUrl, pathWithQuery);
      latch.recordRequestFor(dedicated.id);
      try {
        const upstreamRes = await forwardToEndpoint(
          dedicated,
          req,
          targetUrl,
          method,
          finalBodyText,
          dedicated.modelMap
        );
        if (upstreamRes.ok) {
          latch.recordSuccessFor(dedicated.id);
        } else if (isRateLimitOrQuotaError(upstreamRes.status, await upstreamRes.clone().text())) {
          latch.record429For(dedicated.id, `Status ${upstreamRes.status}`);
        }
        return forwardUpstreamResponse(upstreamRes, dedicated.id, 1);
      } catch (err: unknown) {
        const errorMsg = (err as Error)?.message || String(err);
        console.error(`\x1b[31m[Fetch Error]\x1b[0m Failed to reach ${dedicated.name} (${targetUrl}): ${errorMsg}`);
        return new Response(
          JSON.stringify({
            error: {
              message: `Gateway failed to connect to dedicated upstream: ${errorMsg}`,
              type: "gateway_error",
              code: "upstream_unreachable",
            },
          }),
          {
            status: 502,
            headers: { "Content-Type": "application/json" },
          }
        );
      }
    }
  }

  // --- RS-Latch failover pool --------------------------------------------------
  const maxRetries = Math.min(config.strategy.maxRetriesPerRequest, latch.getPoolSize());

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const currentIndex = latch.getActiveIndex();
    const endpoint = latch.getEndpointByIndex(currentIndex);
    latch.recordRequest(currentIndex);

    const targetUrl = buildTargetUrl(endpoint.baseUrl, pathWithQuery);

    try {
      const upstreamRes = await forwardToEndpoint(endpoint, req, targetUrl, method, finalBodyText);

      // Check if upstream returned rate limit / quota error
      if (upstreamRes.status === 429 || upstreamRes.status === 402) {
        const errText = await upstreamRes.text();
        console.warn(
          `\x1b[31m[Upstream 429]\x1b[0m ${endpoint.name} (${targetUrl}) returned status ${upstreamRes.status}: ${errText.slice(0, 150)}`
        );

        latch.trigger429(currentIndex, `Status ${upstreamRes.status}: ${errText.slice(0, 100)}`);

        // If we have remaining retry attempts, loop will use the newly switched active index
        continue;
      }

      // If response is not 200 OK, check if the error body reveals quota limit
      if (!upstreamRes.ok) {
        const cloned = upstreamRes.clone();
        const errBody = await cloned.text();
        if (isRateLimitOrQuotaError(upstreamRes.status, errBody)) {
          console.warn(
            `\x1b[31m[Upstream Quota Error]\x1b[0m ${endpoint.name} returned quota error in status ${upstreamRes.status}: ${errBody.slice(0, 150)}`
          );
          latch.trigger429(currentIndex, errBody.slice(0, 100));
          continue;
        }
      }

      // Success or standard client error (e.g. 400 bad prompt)
      if (upstreamRes.ok) {
        latch.recordSuccess(currentIndex);
      }

      return forwardUpstreamResponse(upstreamRes, endpoint.id, attempt + 1);
    } catch (err: unknown) {
      const errorMsg = (err as Error)?.message || String(err);
      console.error(`\x1b[31m[Fetch Error]\x1b[0m Failed to reach ${endpoint.name} (${targetUrl}): ${errorMsg}`);

      if (attempt < maxRetries - 1) {
        latch.trigger429(currentIndex, `Network/Fetch error: ${errorMsg}`);
        continue;
      }

      return new Response(
        JSON.stringify({
          error: {
            message: `Gateway failed to connect to upstream: ${errorMsg}`,
            type: "gateway_error",
            code: "upstream_unreachable",
          },
        }),
        {
          status: 502,
          headers: { "Content-Type": "application/json" },
        }
      );
    }
  }

  // All endpoints exhausted with 429
  return new Response(
    JSON.stringify({
      error: {
        message: "All configured endpoints exhausted or rate-limited (RS-Latch full cycle).",
        type: "insufficient_quota",
        code: 429,
      },
    }),
    {
      status: 429,
      headers: { "Content-Type": "application/json" },
    }
  );
}
