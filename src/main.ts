import { App, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { LeaseManager } from "./LeaseManager";
import { SyncthingManager } from "./SyncthingManager";
import {
  DEFAULT_SETTINGS,
  type LeasePluginSettings,
  type LeaseState,
} from "./types";

export default class LeasePlugin extends Plugin {
  settings!: LeasePluginSettings;
  leaseManager!: LeaseManager;
  syncthingManager!: SyncthingManager;
  statusBarEl!: HTMLElement;
  statusBarElSyncthing!: HTMLElement;

  private restartTimeout: number | null = null;

  async onload(): Promise<void> {
    console.debug("[lease-plugin] loading plugin");
    await this.loadSettings();

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.setText("🔐 Leases: starting");
    this.statusBarElSyncthing = this.addStatusBarItem();
    this.statusBarElSyncthing.setText("🔄 Syncthing: checking...");

    this.leaseManager = new LeaseManager(this);
    this.syncthingManager = new SyncthingManager(
      this,
      this.statusBarElSyncthing,
    );
    this.addSettingTab(new LeaseSettingTab(this.app, this));

    this.addCommand({
      id: "reconnect-leases",
      name: "Reconnect leases",
      callback: async () => {
        new Notice("Reconnecting leases...");
        await this.leaseManager.reconnectAll();
      },
    });

    this.addCommand({
      id: "check-syncthing",
      name: "Check Syncthing now",
      callback: async () => {
        await this.syncthingManager.getStatus();
      },
    });

    // These managers are intentionally independent: a missing Syncthing instance
    // must not prevent lease acquisition, and lease failures must not stop health checks.
    void this.syncthingManager.start();
    await this.leaseManager.start();
  }

  async onunload(): Promise<void> {
    console.debug("[lease-plugin] unloading plugin");
    if (this.restartTimeout !== null) {
      window.clearTimeout(this.restartTimeout);
      this.restartTimeout = null;
    }

    this.syncthingManager?.stop();
    if (this.leaseManager) {
      await this.leaseManager.stop();
    }
  }

  updateStatusBar(states: Map<string, LeaseState>): void {
    const values = Array.from(states.values());
    const active = values.filter((value) => value.status === "active").length;
    const total = this.settings.services.length;

    if (total === 0) {
      this.statusBarEl.setText("🔐 No leases");
    } else if (active === total) {
      this.statusBarEl.setText(`🔐 Leases: ${active}/${total}`);
    } else {
      this.statusBarEl.setText(`⚠️ Leases: ${active}/${total}`);
    }

    this.statusBarEl.title = values
      .map((value) => {
        const expiry = value.expiresAt
          ? new Date(value.expiresAt * 1000).toLocaleString()
          : "unknown";
        return `${value.serviceId}: ${value.status} (${expiry})`;
      })
      .join("\n");
  }

  async restartLeaseManager(): Promise<void> {
    if (this.restartTimeout !== null) {
      window.clearTimeout(this.restartTimeout);
    }

    this.restartTimeout = window.setTimeout(async () => {
      this.restartTimeout = null;
      try {
        await this.leaseManager.stop();
        this.leaseManager = new LeaseManager(this);
        await this.leaseManager.start();
        new Notice("Lease manager restarted");
      } catch (error) {
        console.error("[lease-plugin] failed to restart lease manager", error);
        new Notice("Failed to restart lease manager");
      }
    }, 500);
  }

  async restartSyncthingManager(): Promise<void> {
    this.syncthingManager.stop();
    this.syncthingManager = new SyncthingManager(
      this,
      this.statusBarElSyncthing,
    );
    await this.syncthingManager.start();
  }

  async loadSettings(): Promise<void> {
    const loaded =
      (await this.loadData()) as Partial<LeasePluginSettings> | null;
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...loaded,
      services: Array.isArray(loaded?.services)
        ? loaded.services
        : DEFAULT_SETTINGS.services,
    };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

class LeaseSettingTab extends PluginSettingTab {
  private readonly plugin: LeasePlugin;

  constructor(app: App, plugin: LeasePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const containerEl = this.containerEl;
    containerEl.empty();

    new Setting(containerEl).setName("Lease server").setHeading();

    new Setting(containerEl)
      .setName("Base URL")
      .setDesc("Lease server URL")
      .addText((text) =>
        text
          .setPlaceholder("http://localhost:8080")
          .setValue(this.plugin.settings.baseUrl)
          .onChange(async (value) => {
            this.plugin.settings.baseUrl = value.trim();
            await this.plugin.saveSettings();
            await this.plugin.restartLeaseManager();
          }),
      );

    new Setting(containerEl)
      .setName("Lease origin")
      .setDesc("Origin sent when creating leases")
      .addText((text) =>
        text
          .setPlaceholder("obsidian")
          .setValue(this.plugin.settings.origin)
          .onChange(async (value) => {
            this.plugin.settings.origin = value.trim();
            await this.plugin.saveSettings();
            await this.plugin.restartLeaseManager();
          }),
      );

    new Setting(containerEl)
      .setName("Services")
      .setDesc("Comma or newline separated service IDs")
      .addTextArea((text) =>
        text
          .setValue(this.plugin.settings.services.join("\n"))
          .onChange(async (value) => {
            this.plugin.settings.services = value
              .split(/[\n,]/)
              .map((item) => item.trim())
              .filter((item) => item.length > 0);
            await this.plugin.saveSettings();
            await this.plugin.restartLeaseManager();
          }),
      );

    new Setting(containerEl)
      .setName("Renewal buffer seconds")
      .setDesc("Renew a lease this many seconds before it expires")
      .addSlider((slider) =>
        slider
          .setLimits(5, 300, 5)
          .setValue(this.plugin.settings.renewalBufferSeconds)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.renewalBufferSeconds = value;
            await this.plugin.saveSettings();
            await this.plugin.restartLeaseManager();
          }),
      );

    new Setting(containerEl)
      .setName("Max lease retry delay seconds")
      .setDesc("Maximum delay between lease retries")
      .addSlider((slider) =>
        slider
          .setLimits(10, 3600, 10)
          .setValue(this.plugin.settings.maxRetryDelaySeconds)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.maxRetryDelaySeconds = value;
            await this.plugin.saveSettings();
            await this.plugin.restartLeaseManager();
          }),
      );

    new Setting(containerEl).setName("Syncthing").setHeading();

    new Setting(containerEl)
      .setName("Syncthing URL")
      .setDesc(
        "Syncthing web interface URL; /rest/noauth/health is appended automatically",
      )
      .addText((text) =>
        text
          .setPlaceholder("http://localhost:8384")
          .setValue(this.plugin.settings.syncthingUrl)
          .onChange(async (value) => {
            this.plugin.settings.syncthingUrl = value.trim();
            await this.plugin.saveSettings();
            await this.plugin.restartSyncthingManager();
          }),
      );

    new Setting(containerEl)
      .setName("Syncthing API Key")
      .setDesc("Syncthing API key for accessing the REST API")
      .addText((text) =>
        text
          .setPlaceholder("Your Syncthing API Key")
          .setValue(this.plugin.settings.syncthingApiKey)
          .onChange(async (value) => {
            this.plugin.settings.syncthingApiKey = value.trim();
            await this.plugin.saveSettings();
            await this.plugin.restartSyncthingManager();
          }),
      );

    new Setting(containerEl)
      .setName("Syncthing Server Device ID")
      .setDesc("The ID of the Syncthing server to monitor")
      .addText((text) =>
        text
          .setPlaceholder("Server Syncthing Device ID")
          .setValue(this.plugin.settings.syncthingDeviceId)
          .onChange(async (value) => {
            this.plugin.settings.syncthingDeviceId = value.trim();
            await this.plugin.saveSettings();
            await this.plugin.restartSyncthingManager();
          }),
      );
    new Setting(containerEl)
      .setName("Syncthing Folder ID")
      .setDesc("The ID of the Syncthing folder to monitor")
      .addText((text) =>
        text
          .setPlaceholder("Automatically detected, only override if necessary")
          .setValue(this.plugin.settings.syncthingFolderId)
          .onChange(async (value) => {
            this.plugin.settings.syncthingFolderId = value.trim();
            await this.plugin.saveSettings();
            await this.plugin.restartSyncthingManager();
          }),
      );

    new Setting(containerEl)
      .setName("Syncthing check interval seconds")
      .setDesc("How often to check Syncthing while it is healthy")
      .addSlider((slider) =>
        slider
          .setLimits(15, 600, 15)
          .setValue(this.plugin.settings.syncthingCheckIntervalSeconds)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.syncthingCheckIntervalSeconds = value;
            await this.plugin.saveSettings();
            await this.plugin.restartSyncthingManager();
          }),
      );

    new Setting(containerEl)
      .setName("Syncthing retry interval seconds")
      .setDesc("How often to retry while Syncthing is unavailable")
      .addSlider((slider) =>
        slider
          .setLimits(3, 120, 1)
          .setValue(this.plugin.settings.syncthingRetryIntervalSeconds)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.syncthingRetryIntervalSeconds = value;
            await this.plugin.saveSettings();
            await this.plugin.restartSyncthingManager();
          }),
      );
  }
}
