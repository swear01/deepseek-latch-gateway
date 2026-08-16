/**
 * Declared deviations from the canonical DeepSeek official API contract.
 * The gateway exposes the official contract to every client and bridges these
 * deviations per-endpoint; an endpoint without `compat` is a full passthrough.
 */
export interface EndpointCompat {
  /** Upstream rejects `response_format` -> drop it before forwarding */
  stripResponseFormat?: boolean;
  /** Non-official reasoning field name in upstream responses (official: `reasoning_content`); renamed in both non-streaming messages and SSE deltas */
  responseReasoningField?: string;
  /** Upstream wraps errors twice (`{"error":{"message":"<JSON>"}}`) -> unwrap to the official single-layer shape */
  unwrapError?: boolean;
}

export interface EndpointConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  /** Incoming model ids routed exclusively to this endpoint (bypasses the RS-Latch pool) */
  models?: string[];
  /** Per-endpoint rewrite of the outgoing model name: incoming -> upstream */
  modelMap?: Record<string, string>;
  /** Declared deviations from the canonical DeepSeek API contract (default: full passthrough) */
  compat?: EndpointCompat;
  weight?: number;
  extraHeaders?: Record<string, string>;
}

export interface GatewayConfig {
  server: {
    host: string;
    port: number;
    timeoutSeconds: number;
  };
  strategy: {
    mode: "latch" | "fallback";
    debounceSeconds: number;
    maxRetriesPerRequest: number;
  };
  endpoints: EndpointConfig[];
  models?: {
    aliases?: Record<string, string>;
    /** If set, requests whose model is not in this list are rejected (400). */
    allow?: string[];
  };
}

export interface EndpointStats {
  id: string;
  name: string;
  requests: number;
  successCount: number;
  errors429: number;
  last429Time?: string;
  lastSuccessTime?: string;
}

export interface GatewayStatus {
  uptimeSeconds: number;
  activeIndex: number;
  activeEndpoint: {
    id: string;
    name: string;
    baseUrl: string;
  };
  totalRequests: number;
  totalSwitches: number;
  lastSwitchTime?: string;
  lastSwitchReason?: string;
  endpoints: EndpointStats[];
}
