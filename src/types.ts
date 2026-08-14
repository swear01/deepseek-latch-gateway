export interface EndpointConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  models?: string[];
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
