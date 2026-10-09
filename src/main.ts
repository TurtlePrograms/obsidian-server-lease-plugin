import {
  App,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  requestUrl,
} from "obsidian";

interface LeasePluginSettings {
  baseUrl: string;
  origin: string;
  services: string[];
  renewalBufferSeconds: number;
  maxRetryDelaySeconds: number;
}

const DEFAULT_SETTINGS: LeasePluginSettings = {
  baseUrl: "http://localhost:8080",
  origin: "obsidian",
  services: [],
  renewalBufferSeconds: 30,
  maxRetryDelaySeconds: 60,
};

interface StartLeaseResponse {
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

interface LeaseState {
  serviceId: string;
  leaseId: string;
  status: "active" | "failed";
  expiresAt?: number;
  retryCount: number;
}

class LeaseManager {
  private plugin: LeasePlugin;

  private renewalTimers: Map<string, number> = new Map();
  private retryTimers: Map<string, number> = new Map();
  private states: Map<string, LeaseState> = new Map();
  private ensureLeaseInProgress: Set<string> = new Set();

  private isActive = false;

  constructor(plugin: LeasePlugin) {
    this.plugin = plugin;
  }

  private log(message: string, ...args: unknown[]): void {
    console.warn("[lease-plugin]", message, ...args);
  }

  async checkSyncThing(): Promise<void> {
    try {
      const response = await requestUrl({
        url: `http://localhost:8384/rest/noauth/health`,
        method: "GET",
        throw: false,
      });
      if (response.status !== 200) {
        throw new Error(`Syncthing health check failed: ${response.status}`);
      }
      if (response.json?.status !== "OK") {
        throw new Error(
          `Syncthing health check failed: ${response.json?.status}`,
        );
      }
    } catch (error) {
      this.log("failed to check syncthing status", error);
      new Notice(
        "Syncthing health check failed. Please ensure Syncthing is running.",
      );
    }
  }

  async start(): Promise<void> {
    this.log("starting lease manager");

    this.isActive = true;

    if (!this.plugin.settings.services.length) {
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
    this.checkSyncThing().catch((error) => {
      this.log("failed to check syncthing status", error);
    });

    for (const state of this.states.values()) {
      if (state.status === "active" && state.leaseId) {
        try {
          await this.stopLease(state);
        } catch (error) {
          this.log("failed to stop lease", state.serviceId, error);
        }
      }
    }

    for (const timer of this.renewalTimers.values()) {
      window.clearTimeout(timer);
    }

    for (const timer of this.retryTimers.values()) {
      window.clearTimeout(timer);
    }

    this.renewalTimers.clear();
    this.retryTimers.clear();
    this.ensureLeaseInProgress.clear();
    this.states.clear();

    this.plugin.updateStatusBar(this.states);
  }

  async reconnectAll(): Promise<void> {
    this.log("reconnecting all leases");

    await this.stop();

    this.isActive = true;

    for (const serviceId of this.plugin.settings.services) {
      try {
        await this.ensureLease(serviceId);
      } catch (error) {
        this.log("failed to reconnect service", serviceId, error);
      }
    }

    this.plugin.updateStatusBar(this.states);
  }

  private async requestLease(serviceId: string): Promise<StartLeaseResponse> {
    this.log("requesting lease", serviceId);

    const response = await requestUrl({
      url: `${this.plugin.settings.baseUrl}/api/services/${serviceId}/lease`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        origin: this.plugin.settings.origin,
      }),
      throw: false,
    });

    this.log("response", response.json);

    if (response.status !== 200) {
      throw new Error(`Lease request failed: ${response.status}`);
    }

    return response.json;
  }

  private async stopLease(state: LeaseState): Promise<void> {
    this.log("ending lease", state.serviceId, state.leaseId);

    const response = await requestUrl({
      url: `${this.plugin.settings.baseUrl}/api/leases/${state.serviceId}/stop`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        lease_id: state.leaseId,
      }),
      throw: false,
    });

    if (response.status !== 200) {
      throw new Error(`Stop lease failed: ${response.status}`);
    }
  }

  async ensureLease(serviceId: string): Promise<void> {
    if (!this.isActive) {
      return;
    }

    if (this.ensureLeaseInProgress.has(serviceId)) {
      this.log("ensure lease already in progress", serviceId);
      return;
    }

    this.ensureLeaseInProgress.add(serviceId);

    this.log("ensuring lease", serviceId);

    try {
      const leaseResponse = await this.requestLease(serviceId);

      if (!leaseResponse.lease?.lease_id) {
        throw new Error("missing lease id");
      }

      this.setActiveState(serviceId, {
        lease_id: leaseResponse.lease.lease_id,
        expires_at: {
          timestamp: leaseResponse.lease.expiry,
        },
      });

      new Notice(`Lease active: ${serviceId}`);
    } catch (error) {
      this.log("lease failed", serviceId, error);

      this.setFailedState(serviceId);

      new Notice(`Lease failed: ${serviceId}`);

      this.scheduleRetry(serviceId);
    } finally {
      this.ensureLeaseInProgress.delete(serviceId);
    }
  }

  private setActiveState(
    serviceId: string,
    lease: {
      lease_id: string;
      expires_at: {
        timestamp: number;
      };
    },
  ): void {
    this.log("lease active", serviceId, "expires", lease.expires_at.timestamp);

    this.states.set(serviceId, {
      serviceId,
      leaseId: lease.lease_id,
      status: "active",
      expiresAt: lease.expires_at.timestamp,
      retryCount: 0,
    });

    this.clearRetry(serviceId);

    this.scheduleRenewal(serviceId, lease);

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

  private scheduleRenewal(
    serviceId: string,
    lease: {
      expires_at: {
        timestamp: number;
      };
    },
  ): void {
    this.clearRenewal(serviceId);

    const now = Date.now() / 1000;

    const renewInMs = Math.max(
      (lease.expires_at.timestamp -
        now -
        this.plugin.settings.renewalBufferSeconds) *
        1000,
      0,
    );

    this.log(
      "scheduling renewal",
      serviceId,
      "in",
      Math.round(renewInMs / 1000),
      "seconds",
    );

    const timer = window.setTimeout(() => {
      this.ensureLease(serviceId).catch((error) => {
        this.log("renewal failed", serviceId, error);
      });
    }, renewInMs);

    this.renewalTimers.set(serviceId, timer);
  }

  private scheduleRetry(serviceId: string): void {
    this.clearRetry(serviceId);

    const retryCount = this.states.get(serviceId)?.retryCount ?? 1;

    const delaySeconds = Math.min(
      Math.pow(2, retryCount),
      this.plugin.settings.maxRetryDelaySeconds,
    );

    this.log("scheduling retry", serviceId, "in", delaySeconds, "seconds");

    const timer = window.setTimeout(() => {
      this.ensureLease(serviceId).catch((error) => {
        this.log("retry failed", serviceId, error);
      });
    }, delaySeconds * 1000);

    this.retryTimers.set(serviceId, timer);
  }

  private clearRenewal(serviceId: string): void {
    const timer = this.renewalTimers.get(serviceId);

    if (timer) {
      window.clearTimeout(timer);
      this.renewalTimers.delete(serviceId);
    }
  }

  private clearRetry(serviceId: string): void {
    const timer = this.retryTimers.get(serviceId);

    if (timer) {
      window.clearTimeout(timer);
      this.retryTimers.delete(serviceId);
    }
  }
}

export default class LeasePlugin extends Plugin {
  settings!: LeasePluginSettings;
  leaseManager!: LeaseManager;
  statusBarEl!: HTMLElement;

  private restartTimeout: number | null = null;

  async onload(): Promise<void> {
    console.debug("[lease-plugin] loading plugin");

    await this.loadSettings();

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.setText("🔐 Leases: starting");

    this.leaseManager = new LeaseManager(this);

    this.addSettingTab(new LeaseSettingTab(this.app, this));

    this.addCommand({
      id: "reconnect-leases",
      name: "Reconnect leases",
      callback: async () => {
        new Notice("Reconnecting leases...");
        await this.leaseManager.reconnectAll();
      },
    });

    await this.leaseManager.start();
  }

  async onunload(): Promise<void> {
    console.debug("[lease-plugin] unloading plugin");

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
      return;
    }

    if (active === total) {
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
    console.debug("[lease-plugin] restarting lease manager");

    if (this.restartTimeout) {
      window.clearTimeout(this.restartTimeout);
    }

    this.restartTimeout = window.setTimeout(async () => {
      try {
        await this.leaseManager.stop();

        this.leaseManager = new LeaseManager(this);

        await this.leaseManager.start();

        new Notice("Lease manager restarted");
      } catch (error) {
        console.error("[lease-plugin] failed to restart", error);

        new Notice("Failed to restart lease manager");
      }
    }, 500);
  }

  async loadSettings(): Promise<void> {
    const loaded = await this.loadData();

    this.settings = {
      baseUrl: loaded?.baseUrl ?? DEFAULT_SETTINGS.baseUrl,

      origin: loaded?.origin ?? DEFAULT_SETTINGS.origin,

      services: loaded?.services ?? DEFAULT_SETTINGS.services,

      renewalBufferSeconds:
        loaded?.renewalBufferSeconds ?? DEFAULT_SETTINGS.renewalBufferSeconds,

      maxRetryDelaySeconds:
        loaded?.maxRetryDelaySeconds ?? DEFAULT_SETTINGS.maxRetryDelaySeconds,
    };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

class LeaseSettingTab extends PluginSettingTab {
  plugin: LeasePlugin;

  constructor(app: App, plugin: LeasePlugin) {
    super(app, plugin);

    this.plugin = plugin;
  }

  display(): void {
    const containerEl = this.containerEl;

    containerEl.empty();

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
      .setName("Lease Origin")
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
      .setName("Renewal Buffer Seconds")
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
      .setName("Max Retry Delay Seconds")
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
  }
}
