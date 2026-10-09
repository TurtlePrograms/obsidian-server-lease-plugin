export interface LeasePluginSettings {
  baseUrl: string;
  origin: string;
  services: string[];
  renewalBufferSeconds: number;
  maxRetryDelaySeconds: number;
  syncthingUrl: string;
  syncthingCheckIntervalSeconds: number;
  syncthingRetryIntervalSeconds: number;
}

export const DEFAULT_SETTINGS: LeasePluginSettings = {
  baseUrl: "http://localhost:8080",
  origin: "obsidian",
  services: [],
  renewalBufferSeconds: 30,
  maxRetryDelaySeconds: 60,
  syncthingUrl: "http://localhost:8384",
  syncthingCheckIntervalSeconds: 60,
  syncthingRetryIntervalSeconds: 10,
};

export interface StartLeaseResponse {
  status: string;
  service_id: string;
  lease: {
    lease_id: string;
    owner_name: string;
    expiry: number;
    origin: string;
    is_root: number;
  };
}

export interface LeaseState {
  serviceId: string;
  leaseId: string;
  status: "active" | "failed";
  expiresAt?: number;
  retryCount: number;
}
