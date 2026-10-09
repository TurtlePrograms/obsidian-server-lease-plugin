import { Notice, requestUrl } from "obsidian";
import type LeasePlugin from "./main";

/** Independently monitors Syncthing and retries more frequently while it is unavailable. */
export class SyncthingManager {
  private readonly plugin: LeasePlugin;
  private readonly statusBarEl: HTMLElement;
  private checkTimer: number | null = null;
  private isRunning = false;
  private checkInProgress = false;
  private isHealthy: boolean | null = null;
  private hasReportedUnavailable = false;

  constructor(plugin: LeasePlugin, statusBarEl: HTMLElement) {
    this.plugin = plugin;
    this.statusBarEl = statusBarEl;
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.isRunning = true;
    this.statusBarEl.setText("🔄 Syncthing: checking...");
    await this.checkNow();
  }

  async checkNow(): Promise<void> {
    if (!this.isRunning || this.checkInProgress) {
      return;
    }

    this.checkInProgress = true;

    try {
      const baseUrl = this.plugin.settings.syncthingUrl.trim().replace(/\/+$/, "");
      const response = await requestUrl({
        url: `${baseUrl}/rest/noauth/health`,
        method: "GET",
        throw: false,
      });

      if (response.status !== 200 || response.json?.status !== "OK") {
        throw new Error(`Health check returned HTTP ${response.status}, status ${response.json?.status ?? "unknown"}`);
      }

      const recovered = this.isHealthy === false;
      this.isHealthy = true;
      this.statusBarEl.setText("✅ Syncthing: running");

      if (recovered) {
        new Notice("Syncthing connection restored.");
      }
      this.hasReportedUnavailable = false;

      this.log("Syncthing health check succeeded");
    } catch (error) {
      this.isHealthy = false;
      this.statusBarEl.setText("⚠️ Syncthing: not running");
      this.log("Syncthing health check failed", error);

      // Report the outage once, not on every retry attempt.
      if (!this.hasReportedUnavailable) {
        new Notice("Syncthing is unavailable. Retrying automatically.");
        this.hasReportedUnavailable = true;
      }
    } finally {
      this.checkInProgress = false;
      this.scheduleNextCheck();
    }
  }

  stop(): void {
    this.isRunning = false;

    if (this.checkTimer !== null) {
      window.clearTimeout(this.checkTimer);
      this.checkTimer = null;
    }
  }

  private scheduleNextCheck(): void {
    if (!this.isRunning) {
      return;
    }

    if (this.checkTimer !== null) {
      window.clearTimeout(this.checkTimer);
    }

    const intervalSeconds = this.isHealthy
      ? this.plugin.settings.syncthingCheckIntervalSeconds
      : this.plugin.settings.syncthingRetryIntervalSeconds;

    const safeIntervalSeconds = Math.max(1, intervalSeconds);
    this.checkTimer = window.setTimeout(() => {
      this.checkTimer = null;
      void this.checkNow();
    }, safeIntervalSeconds * 1000);
  }

  private log(message: string, ...args: unknown[]): void {
    console.warn("[lease-plugin:SyncthingManager]", message, ...args);
  }
}
