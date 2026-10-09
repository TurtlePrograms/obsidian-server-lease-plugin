import { Notice, requestUrl } from "obsidian";
import type LeasePlugin from "./main";
import type { LeaseState, StartLeaseResponse } from "./types";

export class LeaseManager {
  private readonly plugin: LeasePlugin;
  private readonly renewalTimers: Map<string, number> = new Map();
  private readonly retryTimers: Map<string, number> = new Map();
  private readonly states: Map<string, LeaseState> = new Map();
  private readonly ensureLeaseInProgress: Set<string> = new Set();
  private isActive = false;

  constructor(plugin: LeasePlugin) {
    this.plugin = plugin;
  }

  async start(): Promise<void> {
    this.log("starting lease manager");
    this.isActive = true;

    if (this.plugin.settings.services.length === 0) {
      this.log("no services configured");
      this.plugin.updateStatusBar(this.states);
      return;
    }

    for (const serviceId of this.plugin.settings.services) {
      try {
        await this.ensureLease(serviceId);
      } catch (error) {
        this.log("failed to start service", serviceId, error);
      }
    }

    this.plugin.updateStatusBar(this.states);
  }

  async stop(): Promise<void> {
    this.log("stopping lease manager");
    this.isActive = false;

    for (const timer of this.renewalTimers.values()) {
      window.clearTimeout(timer);
    }
    for (const timer of this.retryTimers.values()) {
      window.clearTimeout(timer);
    }

    this.renewalTimers.clear();
    this.retryTimers.clear();
    this.ensureLeaseInProgress.clear();

    for (const state of this.states.values()) {
      if (state.status !== "active" || !state.leaseId) {
        continue;
      }

      try {
        await this.stopLease(state);
      } catch (error) {
        this.log("failed to stop lease", state.serviceId, error);
      }
    }

    this.states.clear();
    this.plugin.updateStatusBar(this.states);
  }

  async reconnectAll(): Promise<void> {
    this.log("reconnecting all leases");
    await this.stop();
    await this.start();
  }

  async ensureLease(serviceId: string): Promise<void> {
    if (!this.isActive || this.ensureLeaseInProgress.has(serviceId)) {
      return;
    }

    this.ensureLeaseInProgress.add(serviceId);
    this.log("ensuring lease", serviceId);

    try {
      const leaseResponse = await this.requestLease(serviceId);
      if (!leaseResponse.lease?.lease_id) {
        throw new Error("Lease response did not contain a lease ID");
      }

      this.setActiveState(serviceId, leaseResponse);
      new Notice(`Lease active: ${serviceId}`);
    } catch (error) {
      this.log("lease failed", serviceId, error);
      this.setFailedState(serviceId);
      this.scheduleRetry(serviceId);
    } finally {
      this.ensureLeaseInProgress.delete(serviceId);
    }
  }

  private async requestLease(serviceId: string): Promise<StartLeaseResponse> {
    const baseUrl = this.plugin.settings.baseUrl.trim().replace(/\/+$/, "");
    const response = await requestUrl({
      url: `${baseUrl}/api/services/${encodeURIComponent(serviceId)}/lease`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ origin: this.plugin.settings.origin }),
      throw: false,
    });

    if (response.status !== 200) {
      throw new Error(`Lease request failed: HTTP ${response.status}`);
    }

    return response.json as StartLeaseResponse;
  }

  private async stopLease(state: LeaseState): Promise<void> {
    const baseUrl = this.plugin.settings.baseUrl.trim().replace(/\/+$/, "");
    const response = await requestUrl({
      url: `${baseUrl}/api/leases/${encodeURIComponent(state.serviceId)}/stop`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lease_id: state.leaseId }),
      throw: false,
    });

    if (response.status !== 200) {
      throw new Error(`Stop lease failed: HTTP ${response.status}`);
    }
  }

  private setActiveState(serviceId: string, response: StartLeaseResponse): void {
    this.log("lease active", serviceId, "expires", response.lease.expiry);
    this.states.set(serviceId, {
      serviceId,
      leaseId: response.lease.lease_id,
      status: "active",
      expiresAt: response.lease.expiry,
      retryCount: 0,
    });

    this.clearRetry(serviceId);
    this.scheduleRenewal(serviceId, response.lease.expiry);
    this.plugin.updateStatusBar(this.states);
  }

  private setFailedState(serviceId: string): void {
    const retryCount = (this.states.get(serviceId)?.retryCount ?? 0) + 1;
    this.states.set(serviceId, {
      serviceId,
      leaseId: "",
      status: "failed",
      retryCount,
    });
    this.plugin.updateStatusBar(this.states);
  }

  private scheduleRenewal(serviceId: string, expiryTimestamp: number): void {
    this.clearRenewal(serviceId);
    const nowSeconds = Date.now() / 1000;
    const renewInMs = Math.max(
      (expiryTimestamp - nowSeconds - this.plugin.settings.renewalBufferSeconds) * 1000,
      0,
    );

    this.log("scheduling renewal", serviceId, "in", Math.round(renewInMs / 1000), "seconds");
    const timer = window.setTimeout(() => {
      this.renewalTimers.delete(serviceId);
      void this.ensureLease(serviceId);
    }, renewInMs);
    this.renewalTimers.set(serviceId, timer);
  }

  private scheduleRetry(serviceId: string): void {
    this.clearRetry(serviceId);
    const retryCount = this.states.get(serviceId)?.retryCount ?? 1;
    const delaySeconds = Math.min(2 ** retryCount, this.plugin.settings.maxRetryDelaySeconds);

    this.log("scheduling retry", serviceId, "in", delaySeconds, "seconds");
    const timer = window.setTimeout(() => {
      this.retryTimers.delete(serviceId);
      void this.ensureLease(serviceId);
    }, delaySeconds * 1000);
    this.retryTimers.set(serviceId, timer);
  }

  private clearRenewal(serviceId: string): void {
    const timer = this.renewalTimers.get(serviceId);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      this.renewalTimers.delete(serviceId);
    }
  }

  private clearRetry(serviceId: string): void {
    const timer = this.retryTimers.get(serviceId);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      this.retryTimers.delete(serviceId);
    }
  }

  private log(message: string, ...args: unknown[]): void {
    console.warn("[lease-plugin:LeaseManager]", message, ...args);
  }
}
