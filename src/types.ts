export interface EndpointConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  /** Incoming model ids routed exclusively to this endpoint (bypasses the RS-Latch pool) */
  models?: string[];
  /** Per-endpoint rewrite of the outgoing model name: incoming -> upstream */
  modelMap?: Record<string, string>;
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
