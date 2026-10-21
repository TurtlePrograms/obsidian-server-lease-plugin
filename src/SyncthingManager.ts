import { Notice, requestUrl } from "obsidian";
import type LeasePlugin from "./main";
import { SyncthingClient, SyncthingStatus } from "SyncthingApi";
import * as fs from "fs/promises";
import * as path from "path";
/** Independently monitors Syncthing and retries more frequently while it is unavailable. */
export class SyncthingManager {
  private readonly plugin: LeasePlugin;
  private readonly statusBarEl: HTMLElement;
  private checkTimer: number | null = null;
  private isRunning = false;
  private checkInProgress = false;
  private isHealthy: boolean | null = null;
  private hasReportedUnavailable = false;

  private syncthingAPIClient: SyncthingClient | null = null;
  private lastStatus: SyncthingStatus | null = null;

  constructor(plugin: LeasePlugin, statusBarEl: HTMLElement) {
    this.plugin = plugin;
    this.statusBarEl = statusBarEl;
  }

  async getFolderId(): Promise<string | null> {
    try {
      const adapter = this.plugin.app.vault.adapter;

      if (!("getBasePath" in adapter)) {
        throw new Error(
          "This operation requires the desktop filesystem adapter.",
        );
      }

      const basePath = (adapter as { getBasePath(): string }).getBasePath();
      const folderPath = path.join(basePath, ".stfolder");

      const entries = await fs.readdir(folderPath);
      const txtFile = entries.find((entry: string) => entry.endsWith(".txt"));

      if (!txtFile) {
        return null;
      }

      const contents = await fs.readFile(
        path.join(folderPath, txtFile),
        "utf8",
      );
      const regex = /folderID: ([\d\w]{5}-[\d\w]{5})/gm;
      const match = regex.exec(contents);
      if (match && match[1]) {
        return match[1];
      } else {
        return null;
      }
    } catch (error) {
      console.error("Error reading .stfolder:", error);
      return "default"; // Return a default value in case of an error
    }
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    let folderId = this.plugin.settings.syncthingFolderId.trim();
    if (!folderId || folderId === "") {
      folderId = (await this.getFolderId()) ?? "";
    }

    if (!folderId || folderId === "") {
      new Notice(
        "Syncthing folder ID not found. Please set it in the plugin settings.",
      );
      this.statusBarEl.setText("⚠️ Syncthing: folder ID not found");
      return;
    }

    if (!this.plugin.settings.syncthingDeviceId.trim()) {
      new Notice(
        "Syncthing device ID not set. Please set it in the plugin settings.",
      );
      this.statusBarEl.setText("⚠️ Syncthing: device ID not set");
      return;
    }

    if (!this.plugin.settings.syncthingApiKey.trim()) {
      new Notice(
        "Syncthing API key not set. Please set it in the plugin settings.",
      );
      this.statusBarEl.setText("⚠️ Syncthing: API key not set");
      return;
    }

    this.syncthingAPIClient = new SyncthingClient(
      this.plugin.settings.syncthingUrl.trim().replace(/\/+$/, ""),
      this.plugin.settings.syncthingApiKey.trim(),
      folderId,
      this.plugin.settings.syncthingDeviceId.trim(),
    );

    this.isRunning = true;
    this.statusBarEl.setText("🔄 Syncthing: checking...");
    await this.syncthingAPIClient.startMonitoring(
      (status) => {
        this.lastStatus = status;
        if (status.local.running === false) {
          this.statusBarEl.setText("⚠️ Syncthing: not running");
          return;
        }

        if (status.server.connection !== "connected") {
          this.statusBarEl.setText("⚠️ Syncthing: not connected");
          return;
        }

        if (status.folder.upToDate) {
          this.statusBarEl.setText("✅ Syncthing: up to date");
          return;
        }

        if (status.folder.state !== "idle") {
          this.statusBarEl.setText(
            "⚠️ Syncthing: syncing... (" + status.folder.needTotalItems + ")",
          );
          return;
        }
      },
      {
        mode: "events",
      },
    );
  }

  async getStatus(): Promise<SyncthingStatus | null> {
    try {
      const status = await this.syncthingAPIClient?.getStatus();
      if (!status) {
        throw new Error("Failed to retrieve Syncthing status");
      }
      this.lastStatus = status;
      return status;
    } catch (error) {
      console.error("Failed to retrieve Syncthing status", error);
      return null;
    }
  }

  stop(): void {
    this.isRunning = false;
    this.syncthingAPIClient?.stopMonitoring();
  }
}
