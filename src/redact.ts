import type { ProviderConfig } from "./types";

/** Strip the provider's own key and other credential-shaped values from upstream text before logging it. */
export function redactCredentials(text: string, provider: ProviderConfig): string {
  const headerSecrets = Object.values(provider.extraHeaders ?? {}).filter(value => value.length >= 8);
  const secrets = [provider.apiKey, ...headerSecrets]
    .filter(Boolean)
    .flatMap(secret => [secret, JSON.stringify(secret).slice(1, -1)])
    .sort((a, b) => b.length - a.length);
  const withoutSecrets = secrets.reduce((out, secret) => out.split(secret).join("[redacted]"), text);
  return withoutSecrets
    .slice(0, 512)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/(?<![A-Za-z0-9])(?:oc_sk|sk|rk|pk|key|token)[-_:=]\s*(?=[A-Za-z0-9_-]*\d|[A-Za-z0-9_-]{20})[A-Za-z0-9_-]+/gi, "[redacted]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]");
}

/** A redacted, length-capped excerpt of an upstream body for logs and diagnostics. */
export function upstreamSnippet(text: string, provider: ProviderConfig, maxLength: number): string {
  return redactCredentials(text, provider).slice(0, maxLength);
}
