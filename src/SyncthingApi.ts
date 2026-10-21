import { requestUrl } from "obsidian";

export type ConnectionStatus = "connected" | "disconnected" | "unknown";

export type FolderSyncState =
  | "idle"
  | "syncing"
  | "scanning"
  | "paused"
  | "error"
  | "unknown";

export interface SyncthingStatus {
  local: {
    running: boolean | null;
    error?: string;
  };
  server: {
    deviceId: string;
    connection: ConnectionStatus;
  };
  folder: {
    folderId: string;
    state: FolderSyncState;
    upToDate: boolean | null;
    needFiles: number;
    needDirectories: number;
    needSymlinks: number;
    needDeletes: number;
    needBytes: number;
    needTotalItems: number;
    message?: string;
  };
  checkedAt: string;
}

type MonitoringMode = "polling" | "events";

interface SyncthingEvent {
  id: number;
  type: string;
  data: Record<string, unknown>;
}

interface DeviceConnection {
  connected: boolean;
  paused: boolean;
  address: string;
  clientVersion: string;
}

interface ConnectionsResponse {
  connections: Record<string, DeviceConnection>;
}

interface FolderStatusResponse {
  errors: number;
  pullErrors: number;
  invalid: string;
  needFiles: number;
  needDirectories: number;
  needSymlinks: number;
  needDeletes: number;
  needBytes: number;
  needTotalItems: number;
  receiveOnlyTotalItems: number;
  state: string;
  stateChanged: string;
  error: string;
  globalTotalItems: number;
  localTotalItems: number;
  remoteSequence: Record<string, number>;
}

interface MonitorOptions {
  mode?: MonitoringMode;
  intervalMs?: number;
}

interface DeviceCompletionResponse {
  completion: number;
  needBytes: number;
  needItems: number;
  needDeletes: number;
  remoteState: "valid" | "paused" | "notSharing" | "unknown";
  sequence: number;
}

export class SyncthingClient {
  private monitoring = false;
  private monitorGeneration = 0;

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly folderId: string,
    private readonly deviceId: string,
  ) {}

  private async get<T>(path: string): Promise<T> {
    const response = await requestUrl({
      url: `${this.baseUrl.replace(/\/+$/, "")}${path}`,
      method: "GET",
      headers: {
        "X-API-Key": this.apiKey,
      },
      throw: false,
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `Syncthing API GET ${path} returned HTTP ${response.status}`,
      );
    }

    // Obsidian's requestUrl response exposes JSON as a property.
    return response.json as T;
  }

  async getStatus(): Promise<SyncthingStatus> {
    const checkedAt = new Date().toISOString();

    let running: boolean | null = null;
    let localError: string | undefined;

    let connection: ConnectionStatus = "unknown";

    let folderState: FolderSyncState = "unknown";
    let upToDate: boolean | null = null;
    let needFiles = 0;
    let needDirectories = 0;
    let needSymlinks = 0;
    let needDeletes = 0;
    let needBytes = 0;
    let needTotalItems = 0;
    let folderMessage: string | undefined;

    // 1. Check the local Syncthing instance.
    try {
      const ping = await this.get<{ ping: string }>("/rest/system/ping");

      running = ping.ping === "pong";
    } catch (error: unknown) {
      localError = error instanceof Error ? error.message : String(error);
    }

    if (running !== true) {
      return {
        local: { running, error: localError },
        server: {
          deviceId: this.deviceId,
          connection: "unknown",
        },
        folder: {
          folderId: this.folderId,
          state: "unknown",
          upToDate: null,
          needFiles,
          needDirectories,
          needSymlinks,
          needDeletes,
          needBytes,
          needTotalItems,
          message: "Local Syncthing is unavailable",
        },
        checkedAt,
      };
    }

    // 2. Retrieve connection and folder information independently.
    let connections: ConnectionsResponse | null = null;
    let folder: FolderStatusResponse | null = null;
    let completion: DeviceCompletionResponse | null = null;

    try {
      connections = await this.get<ConnectionsResponse>(
        "/rest/system/connections",
      );

      const device = connections.connections[this.deviceId];

      if (!device || device.paused || !device.connected) {
        connection = "disconnected";
      } else {
        connection = "connected";
      }
    } catch (error: unknown) {
      localError = error instanceof Error ? error.message : String(error);
    }

    try {
      folder = await this.get<FolderStatusResponse>(
        `/rest/db/status?folder=${encodeURIComponent(this.folderId)}`,
      );

      needFiles = folder.needFiles;
      needDirectories = folder.needDirectories;
      needSymlinks = folder.needSymlinks;
      needDeletes = folder.needDeletes;
      needBytes = folder.needBytes;
      needTotalItems = folder.needTotalItems;

      switch (folder.state.toLowerCase()) {
        case "idle":
          folderState = "idle";
          break;
        case "syncing":
        case "sync-waiting":
          folderState = "syncing";
          break;
        case "scanning":
        case "scan-waiting":
          folderState = "scanning";
          break;
        case "paused":
          folderState = "paused";
          break;
        case "error":
          folderState = "error";
          break;
        default:
          folderState = "unknown";
          break;
      }

      if (folder.invalid) {
        folderState = "error";
        folderMessage = folder.invalid;
      } else if (folder.error) {
        folderState = "error";
        folderMessage = folder.error;
      } else if (folder.errors > 0 || folder.pullErrors > 0) {
        folderState = "error";
        folderMessage =
          `${folder.errors} error(s), ` + `${folder.pullErrors} pull error(s)`;
      }
    } catch (error: unknown) {
      folderMessage = error instanceof Error ? error.message : String(error);
    }

    // 3. Check how much the remote device still needs.
    try {
      completion = await this.get<DeviceCompletionResponse>(
        `/rest/db/completion?folder=${encodeURIComponent(this.folderId)}` +
          `&device=${encodeURIComponent(this.deviceId)}`,
      );
    } catch (error: unknown) {
      folderMessage =
        folderMessage ??
        (error instanceof Error ? error.message : String(error));
    }

    // 4. Determine whether synchronization is fully complete.
    if (folder === null || completion === null) {
      upToDate = null;
    } else {
      const localHasNoPendingWork =
        folder.needFiles === 0 &&
        folder.needDirectories === 0 &&
        folder.needSymlinks === 0 &&
        folder.needDeletes === 0 &&
        folder.needBytes === 0 &&
        folder.needTotalItems === 0 &&
        folder.receiveOnlyTotalItems === 0;

      const remoteHasNoPendingWork =
        completion.needItems === 0 &&
        completion.needBytes === 0 &&
        completion.needDeletes === 0 &&
        completion.completion === 100 &&
        completion.remoteState === "valid";

      const noErrors =
        folder.errors === 0 &&
        folder.pullErrors === 0 &&
        !folder.error &&
        !folder.invalid;

      if (folderState === "error" || folderState === "paused") {
        upToDate = false;
      } else if (connection !== "connected" || folderState === "unknown") {
        upToDate = null;
      } else {
        upToDate =
          folderState === "idle" &&
          noErrors &&
          localHasNoPendingWork &&
          remoteHasNoPendingWork;
      }
    }

    return {
      local: {
        running,
        error: localError,
      },
      server: {
        deviceId: this.deviceId,
        connection,
      },
      folder: {
        folderId: this.folderId,
        state: folderState,
        upToDate,
        needFiles,
        needDirectories,
        needSymlinks,
        needDeletes,
        needBytes,
        needTotalItems,
        message: folderMessage,
      },
      checkedAt,
    };
  }

  async startMonitoring(
    onUpdate: (status: SyncthingStatus) => void,
    options: MonitorOptions = {},
  ): Promise<void> {
    this.stopMonitoring();

    this.monitoring = true;
    const generation = this.monitorGeneration;

    const mode = options.mode ?? "events";
    const intervalMs = options.intervalMs ?? 5000;

    let previousStatus = "";

    const publishStatus = async (): Promise<void> => {
      let status: SyncthingStatus;

      try {
        status = await this.getStatus();
      } catch (error: unknown) {
        this.log("Failed to retrieve Syncthing status", error);
        return;
      }

      if (!this.monitoring || generation !== this.monitorGeneration) {
        return;
      }

      // Don't notify the consumer when only the timestamp changed.
      const comparableStatus = JSON.stringify({
        ...status,
        checkedAt: undefined,
      });

      if (comparableStatus !== previousStatus) {
        previousStatus = comparableStatus;
        onUpdate(status);
      }
    };

    // Always emit the initial state.
    await publishStatus();

    if (!this.monitoring || generation !== this.monitorGeneration) {
      return;
    }

    if (mode === "polling") {
      void this.pollLoop(intervalMs, generation, publishStatus);
    } else {
      void this.eventLoop(generation, publishStatus);
    }
  }

  private async pollLoop(
    intervalMs: number,
    generation: number,
    refresh: () => Promise<void>,
  ): Promise<void> {
    while (this.monitoring && generation === this.monitorGeneration) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, intervalMs);
      });

      if (this.monitoring && generation === this.monitorGeneration) {
        await refresh();
      }
    }
  }

  private async eventLoop(
    generation: number,
    refresh: () => Promise<void>,
  ): Promise<void> {
    let since = 0;

    // Start near the latest event instead of replaying old history.
    try {
      const latest = await this.get<SyncthingEvent[]>(
        "/rest/events?since=0&limit=1",
      );

      if (latest.length > 0) {
        since = latest[latest.length - 1].id;
      }
    } catch (error: unknown) {
      this.log("Failed to initialize Syncthing events", error);
      return;
    }

    while (this.monitoring && generation === this.monitorGeneration) {
      try {
        const events = await this.get<SyncthingEvent[]>(
          `/rest/events?since=${since}&timeout=30`,
        );

        if (!this.monitoring || generation !== this.monitorGeneration) {
          return;
        }

        if (events.length > 0) {
          since = Math.max(since, ...events.map((event) => event.id));

          await refresh();
        }
      } catch (error: unknown) {
        this.log("Syncthing event request failed", error);

        // Avoid a tight retry loop when the API is unavailable.
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 2000);
        });
      }
    }
  }

  stopMonitoring(): void {
    this.monitoring = false;
    this.monitorGeneration++;
  }

  private log(message: string, ...args: unknown[]): void {
    console.warn("[lease-plugin:LeaseManager]", message, ...args);
  }
}
