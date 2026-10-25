/**
 * Declared deviations from the canonical DeepSeek official API contract.
 * The gateway exposes the official contract to every client and bridges these
 * deviations per-provider; a provider without `compat` is a full passthrough.
 */
export interface ProviderCompat {
  /** Upstream rejects `response_format` -> drop it before forwarding */
  stripResponseFormat?: boolean;
  /** Non-official reasoning field name in upstream responses (official: `reasoning_content`); renamed in both non-streaming messages and SSE deltas */
  responseReasoningField?: string;
  /** Upstream wraps errors twice (`{"error":{"message":"<JSON>"}}`) -> unwrap to the official single-layer shape */
  unwrapError?: boolean;
}

export interface ProviderConfig {
  id: string;
  baseUrl: string;
  apiKey: string;
  compat?: ProviderCompat;
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, unknown>;
}

/** One upstream for a public model: which provider, and the model name sent to it. */
export interface Deployment {
  provider: string;
  model: string;
}

export interface GatewayConfig {
  server: {
    host: string;
    port: number;
    timeoutSeconds: number;
  };
  providers: Record<string, ProviderConfig>;
  /** Public model id -> deployments tried in order. The keys are the only accepted model ids. */
  models: Record<string, Deployment[]>;
}
