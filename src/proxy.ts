import type { GatewayConfig } from "./types";
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

function rewriteRequestBody(bodyText: string, config: GatewayConfig): string {
  if (!config.models?.aliases || Object.keys(config.models.aliases).length === 0) {
    return bodyText;
  }
  try {
    const json = JSON.parse(bodyText);
    if (json.model && config.models.aliases[json.model]) {
      const originalModel = json.model;
      json.model = config.models.aliases[originalModel];
      return JSON.stringify(json);
    }
  } catch {
    // Non-JSON body, leave as is
  }
  return bodyText;
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

  const finalBodyText = rewriteRequestBody(rawBodyText, config);
  const maxRetries = Math.min(config.strategy.maxRetriesPerRequest, config.endpoints.length);

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const currentIndex = latch.getActiveIndex();
    const endpoint = latch.getEndpointByIndex(currentIndex);
    latch.recordRequest(currentIndex);

    // Build target upstream URL (prevent double /v1/v1)
    let cleanBase = endpoint.baseUrl.replace(/\/+$/, "");
    let cleanPath = pathWithQuery;
    if (cleanBase.endsWith("/v1") && cleanPath.startsWith("/v1")) {
      cleanPath = cleanPath.slice(3);
    }
    const targetUrl = `${cleanBase}${cleanPath}`;

    // Prepare forward headers
    const headers = new Headers();
    req.headers.forEach((val, key) => {
      const lowerKey = key.toLowerCase();
      // Drop hop-by-hop headers and host
      if (lowerKey !== "host" && lowerKey !== "authorization" && lowerKey !== "content-length") {
        headers.set(key, val);
      }
    });

    // Inject active endpoint API Key
    headers.set("Authorization", `Bearer ${endpoint.apiKey}`);

    if (endpoint.extraHeaders) {
      for (const [k, v] of Object.entries(endpoint.extraHeaders)) {
        headers.set(k, v);
      }
    }

    try {
      const upstreamRes = await fetch(targetUrl, {
        method,
        headers,
        body: method !== "GET" && method !== "HEAD" ? finalBodyText : undefined,
        signal: req.signal,
      });

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

      // Forward headers from upstream back to client
      const responseHeaders = new Headers();
      upstreamRes.headers.forEach((val, key) => {
        const lowerKey = key.toLowerCase();
        if (lowerKey !== "content-encoding" && lowerKey !== "content-length" && lowerKey !== "transfer-encoding") {
          responseHeaders.set(key, val);
        }
      });

      // Add debug indicator headers
      responseHeaders.set("X-Gateway-Active-Endpoint", endpoint.id);
      responseHeaders.set("X-Gateway-Attempt", String(attempt + 1));

      return new Response(upstreamRes.body, {
        status: upstreamRes.status,
        statusText: upstreamRes.statusText,
        headers: responseHeaders,
      });
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
