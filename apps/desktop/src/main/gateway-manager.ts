import { type ChildProcessByStdio, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import type { Readable } from "node:stream";
import { readGatewayDiscoveryFile, resolveAppPaths } from "@localhub/platform";
import {
  type DesktopShellState,
  type GatewayDiscoveryFile,
  type GatewayEvent,
  type GatewayHealthSnapshot,
  type PublicModelList,
  type RequestRoute,
  desktopShellStateSchema,
  gatewayEventSchema,
  gatewayHealthSnapshotSchema,
  publicModelListSchema,
} from "@localhub/shared-contracts";
import WebSocket, { type RawData } from "ws";

type GatewayManagerEvents = {
  state: (state: DesktopShellState) => void;
  event: (event: GatewayEvent) => void;
};

type RawGatewayHealth = {
  status: "ok";
  plane: "public" | "control";
  uptimeMs: number;
  loadedModelCount: number;
  activeWebSocketClients: number;
};

type RawPublicModel = {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
};

type RawRuntimeModel = RawPublicModel & {
  loaded: boolean;
  state: "Idle" | "Loading" | "Ready" | "Busy" | "Unloading" | "Crashed" | "CoolingDown";
  capabilities: string[];
};

type LegacyGatewayEvent = {
  type: "MODEL_STATE_CHANGED" | "LOG_STREAM" | "METRICS_TICK" | "REQUEST_TRACE";
  ts: string;
  traceId?: string;
  payload: Record<string, unknown>;
};

type RawPublicModelsResponse = {
  object: "list";
  data: RawPublicModel[];
};

type RawRuntimeModelsResponse = {
  data: RawRuntimeModel[];
};

export type DesktopSystemPaths = {
  workspaceRoot: string;
  supportDir: string;
  discoveryFile: string;
};

const resolveGatewayEntrypoint = (workspaceRoot: string): string => {
  const candidatePaths = [
    path.join(workspaceRoot, "services", "gateway", "dist", "index.js"),
    path.join(process.resourcesPath, "services", "gateway", "dist", "index.js"),
  ];

  for (const candidatePath of candidatePaths) {
    if (existsSync(candidatePath)) {
      return candidatePath;
    }
  }

  throw new Error(
    `Unable to locate the built gateway entrypoint. Expected one of: ${candidatePaths.join(", ")}`,
  );
};

const sleep = async (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const toDesktopModelState = (
  state: RawRuntimeModel["state"],
): "idle" | "loading" | "ready" | "evicting" | "error" => {
  switch (state) {
    case "Loading":
      return "loading";
    case "Ready":
    case "Busy":
      return "ready";
    case "Unloading":
    case "CoolingDown":
      return "evicting";
    case "Crashed":
      return "error";
    default:
      return "idle";
  }
};

const toLifecycleState = (
  state: RawRuntimeModel["state"],
): "Loading" | "Ready" | "Busy" | "Unloading" | "Crashed" | "CoolingDown" => {
  if (state === "Idle") {
    return "CoolingDown";
  }

  return state;
};

const prettifyModelName = (modelId: string): string =>
  modelId
    .split("/")
    .at(-1)
    ?.split("-")
    .map((segment) =>
      segment.length === 0 ? segment : `${segment.charAt(0).toUpperCase()}${segment.slice(1)}`,
    )
    .join(" ") ?? modelId;

const buildRuntimeKey = (modelId: string) => ({
  modelId,
  engineType: "llama.cpp",
  role: "chat" as const,
  configHash: "stage1-mock",
});

const isLegacyGatewayEvent = (value: unknown): value is LegacyGatewayEvent => {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.type === "string" &&
    !!candidate.payload &&
    typeof candidate.payload === "object"
  );
};

const mapRequestRoute = (method: string, pathName: string): RequestRoute | null => {
  const signature = `${method.toUpperCase()} ${pathName}`;

  switch (signature) {
    case "GET /healthz":
    case "GET /v1/models":
    case "GET /control/health":
    case "GET /control/models":
    case "POST /control/models/preload":
    case "POST /control/models/evict":
    case "POST /control/system/shutdown":
    case "GET /control/downloads":
    case "POST /control/downloads":
    case "GET /control/engines":
    case "POST /control/engines":
      return signature as RequestRoute;
    default:
      return null;
  }
};

const toLogLevel = (value: unknown): "debug" | "info" | "warn" | "error" => {
  if (value === "debug" || value === "warn" || value === "error") {
    return value;
  }

  return "info";
};

const toRawWorkerState = (value: unknown): RawRuntimeModel["state"] => {
  if (
    value === "Loading" ||
    value === "Ready" ||
    value === "Busy" ||
    value === "Unloading" ||
    value === "Crashed" ||
    value === "CoolingDown"
  ) {
    return value;
  }

  return "Idle";
};

export class GatewayManager extends EventEmitter {
  private child: ChildProcessByStdio<null, Readable, Readable> | undefined;
  private controlSocket: WebSocket | undefined;
  private discovery: GatewayDiscoveryFile | undefined;
  private stopping = false;
  private readonly stateValue: DesktopShellState = desktopShellStateSchema.parse({
    phase: "idle",
    progress: 0,
    message: "Waiting to launch the gateway.",
    discovery: null,
    lastError: null,
    startedAt: null,
    lastEventAt: null,
  });

  readonly paths: DesktopSystemPaths;

  constructor(workspaceRootOverride?: string) {
    super();

    const workspaceRoot = workspaceRootOverride ?? path.resolve(__dirname, "..", "..", "..");
    const appPaths = resolveAppPaths({
      cwd: workspaceRoot,
    });

    this.paths = {
      workspaceRoot,
      supportDir: appPaths.supportRoot,
      discoveryFile: appPaths.discoveryFile,
    };
  }

  override on<U extends keyof GatewayManagerEvents>(
    eventName: U,
    listener: GatewayManagerEvents[U],
  ): this {
    return super.on(eventName, listener);
  }

  getState(): DesktopShellState {
    return desktopShellStateSchema.parse(this.stateValue);
  }

  async start(): Promise<void> {
    if (this.child) {
      return;
    }

    this.updateState({
      phase: "launching",
      progress: 10,
      message: "Launching gateway process.",
      lastError: null,
    });

    await rm(this.paths.discoveryFile, { force: true });
    this.child = this.spawnGatewayProcess();
    this.attachProcessLogging(this.child);

    this.child.once("spawn", () => {
      this.updateState({
        phase: "waiting_for_discovery",
        progress: 35,
        message: "Waiting for gateway discovery file.",
      });
    });

    this.child.once("exit", (code) => {
      this.child = undefined;
      this.controlSocket = undefined;

      if (!this.stopping) {
        this.updateState({
          phase: "error",
          progress: 100,
          message: "Gateway process stopped unexpectedly.",
          lastError: `Gateway exited with code ${code ?? -1}.`,
        });
      } else {
        this.updateState({
          phase: "stopped",
          progress: 100,
          message: "Gateway stopped.",
          lastError: null,
        });
      }
    });

    try {
      const discovery = await this.waitForDiscovery();
      this.discovery = discovery;
      this.updateState({
        phase: "connecting",
        progress: 70,
        message: "Connecting to gateway telemetry.",
        discovery,
        startedAt: discovery.generatedAt,
      });

      await this.connectTelemetry(discovery);
      await this.getHealth();

      this.updateState({
        phase: "connected",
        progress: 100,
        message: "Desktop shell connected to gateway scaffolding.",
        lastError: null,
      });
    } catch (error) {
      this.updateState({
        phase: "error",
        progress: 100,
        message: "Gateway bootstrap failed.",
        lastError: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async listModels(): Promise<PublicModelList> {
    const discovery = this.requireDiscovery();
    const [publicResponse, runtimeResponse] = await Promise.all([
      fetch(`${discovery.publicBaseUrl}/v1/models`),
      fetch(`${discovery.controlBaseUrl}/control/models`),
    ]);

    const publicJson = (await publicResponse.json()) as RawPublicModelsResponse;
    const runtimeJson = (await runtimeResponse.json()) as RawRuntimeModelsResponse;
    const runtimeMap = new Map(runtimeJson.data.map((model) => [model.id, model]));

    return publicModelListSchema.parse({
      object: "list",
      data: publicJson.data.map((model) => {
        const runtime = runtimeMap.get(model.id);

        return {
          id: model.id,
          name: prettifyModelName(model.id),
          engine: "llama.cpp",
          state: runtime ? toDesktopModelState(runtime.state) : "idle",
          sizeLabel: runtime?.loaded ? "Warm mock worker" : "Mock registry entry",
          tags: runtime?.capabilities ?? [],
          description: runtime?.loaded
            ? "Live placeholder wired through the mocked control plane."
            : "Available in the mocked runtime registry for Stage 1 shell work.",
          lastUsedAt: new Date(model.created * 1000).toISOString(),
        };
      }),
    });
  }

  async getHealth(): Promise<GatewayHealthSnapshot> {
    const discovery = this.requireDiscovery();
    const response = await fetch(`${discovery.controlBaseUrl}/control/health`);
    const raw = (await response.json()) as RawGatewayHealth;

    return gatewayHealthSnapshotSchema.parse({
      state: raw.status === "ok" ? "ready" : "degraded",
      publicBaseUrl: discovery.publicBaseUrl,
      controlBaseUrl: discovery.controlBaseUrl,
      uptimeMs: raw.uptimeMs,
      activeWorkers: raw.loadedModelCount,
      queuedRequests: 0,
      generatedAt: new Date().toISOString(),
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;

    if (this.discovery) {
      try {
        await fetch(`${this.discovery.controlBaseUrl}/control/system/shutdown`, {
          method: "POST",
        });
      } catch {
        /* noop */
      }
    }

    this.controlSocket?.close();

    if (this.child) {
      this.child.kill("SIGTERM");
      await sleep(500);
    }
  }

  private requireDiscovery(): GatewayDiscoveryFile {
    if (!this.discovery) {
      throw new Error("Gateway discovery is not available yet.");
    }

    return this.discovery;
  }

  private spawnGatewayProcess(): ChildProcessByStdio<null, Readable, Readable> {
    const gatewayEntry = resolveGatewayEntrypoint(this.paths.workspaceRoot);

    return spawn(process.execPath, [gatewayEntry], {
      cwd: this.paths.workspaceRoot,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        LOCAL_LLM_HUB_APP_SUPPORT_DIR: this.paths.supportDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  private attachProcessLogging(child: ChildProcessByStdio<null, Readable, Readable>): void {
    const emitLog = (sourceLabel: string, level: "info" | "error", chunk: Buffer) => {
      const lines = chunk
        .toString("utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

      for (const message of lines) {
        this.emitEvent({
          type: "LOG_STREAM",
          ts: new Date().toISOString(),
          traceId: randomUUID(),
          payload: {
            runtimeKey: buildRuntimeKey("localhub/system"),
            level,
            message: `${sourceLabel}: ${message}`,
            source: "system",
          },
        });
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      emitLog("gateway", "info", chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      emitLog("gateway", "error", chunk);
    });
  }

  private async waitForDiscovery(timeoutMs = 20_000): Promise<GatewayDiscoveryFile> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const discovery = readGatewayDiscoveryFile(this.paths.discoveryFile);
      if (discovery) {
        return discovery;
      }

      await sleep(250);
    }

    throw new Error("Timed out waiting for gateway discovery file.");
  }

  private async connectTelemetry(discovery: GatewayDiscoveryFile): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(discovery.websocketUrl);
      let settled = false;

      socket.on("open", () => {
        this.controlSocket = socket;

        if (!settled) {
          settled = true;
          resolve();
        }
      });

      socket.on("message", (chunk: RawData) => {
        try {
          const raw = JSON.parse(chunk.toString("utf8")) as unknown;
          const event = this.adaptGatewayEvent(raw);
          if (event) {
            this.emitEvent(event);
          }
        } catch (error) {
          this.updateState({
            lastError:
              error instanceof Error
                ? `Invalid gateway event: ${error.message}`
                : "Invalid gateway event.",
          });
        }
      });

      socket.on("close", () => {
        if (!this.stopping) {
          this.updateState({
            phase: "error",
            message: "Lost connection to gateway telemetry.",
            lastError: "The control WebSocket closed unexpectedly.",
          });
        }
      });

      socket.on("error", (error: Error) => {
        if (!settled) {
          settled = true;
          reject(error);
          return;
        }

        this.updateState({
          phase: "error",
          message: "Gateway telemetry connection failed.",
          lastError: error.message,
        });
      });
    });
  }

  private adaptGatewayEvent(raw: unknown): GatewayEvent | null {
    const sharedEvent = gatewayEventSchema.safeParse(raw);
    if (sharedEvent.success) {
      return sharedEvent.data;
    }

    if (!isLegacyGatewayEvent(raw)) {
      return null;
    }

    const traceId = raw.traceId ?? randomUUID();
    const ts = raw.ts ?? new Date().toISOString();

    switch (raw.type) {
      case "MODEL_STATE_CHANGED":
        return gatewayEventSchema.parse({
          type: "MODEL_STATE_CHANGED",
          ts,
          traceId,
          payload: {
            modelId: String(raw.payload.modelId ?? "localhub/unknown"),
            runtimeKey: buildRuntimeKey(String(raw.payload.modelId ?? "localhub/unknown")),
            nextState: toLifecycleState(toRawWorkerState(raw.payload.state)),
            reason: raw.payload.loaded === true ? "Mock runtime warmed." : "Mock runtime cooled.",
          },
        });
      case "LOG_STREAM":
        return gatewayEventSchema.parse({
          type: "LOG_STREAM",
          ts,
          traceId,
          payload: {
            runtimeKey: buildRuntimeKey(String(raw.payload.modelId ?? "localhub/system")),
            level: toLogLevel(raw.payload.level),
            message: String(raw.payload.message ?? "Gateway log"),
            source: "gateway",
          },
        });
      case "METRICS_TICK": {
        const activeWorkers = Number(raw.payload.loadedModelCount ?? 0);
        return gatewayEventSchema.parse({
          type: "METRICS_TICK",
          ts,
          traceId,
          payload: {
            activeWorkers,
            queuedRequests: 0,
            residentMemoryBytes: activeWorkers * 2_147_483_648,
            gpuMemoryBytes: activeWorkers * 1_073_741_824,
          },
        });
      }
      case "REQUEST_TRACE": {
        const method = String(raw.payload.method ?? "GET");
        const pathName = String(raw.payload.path ?? "/control/health");
        const route = mapRequestRoute(method, pathName);

        if (!route) {
          return null;
        }

        const durationMs = Number(raw.payload.durationMs ?? 0);
        return gatewayEventSchema.parse({
          type: "REQUEST_TRACE",
          ts,
          traceId,
          payload: {
            traceId,
            requestId: String(raw.payload.requestId ?? traceId),
            route,
            method:
              method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE"
                ? method
                : "GET",
            receivedAt: new Date(Date.parse(ts) - durationMs).toISOString(),
            completedAt: ts,
            durationMs,
            statusCode: Number(raw.payload.statusCode ?? 200),
            metadata: {
              plane: raw.payload.plane ?? "control",
            },
          },
        });
      }
      default:
        return null;
    }
  }

  private emitEvent(event: GatewayEvent): void {
    const parsed = gatewayEventSchema.parse(event);
    this.stateValue.lastEventAt = parsed.ts;
    this.emit("event", parsed);
    this.emit("state", this.getState());
  }

  private updateState(next: Partial<DesktopShellState>): void {
    const parsed = desktopShellStateSchema.parse({
      ...this.stateValue,
      ...next,
    });

    Object.assign(this.stateValue, parsed);
    this.emit("state", this.getState());
  }
}
