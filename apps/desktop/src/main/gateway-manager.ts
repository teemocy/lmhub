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
  type DesktopEngineList,
  type DesktopLocalModelImportRequest,
  type DesktopLocalModelImportResponse,
  type DesktopModelLibrary,
  type DesktopModelRecord,
  type DesktopShellState,
  type GatewayDiscoveryFile,
  type GatewayEvent,
  type GatewayHealthSnapshot,
  type PublicModelList,
  type RequestRoute,
  desktopEngineListSchema,
  desktopLocalModelImportResponseSchema,
  desktopModelLibrarySchema,
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

type LegacyWorkerState =
  | "Idle"
  | "Loading"
  | "Ready"
  | "Busy"
  | "Unloading"
  | "Crashed"
  | "CoolingDown";

type LegacyGatewayEvent = {
  type: "MODEL_STATE_CHANGED" | "LOG_STREAM" | "METRICS_TICK" | "REQUEST_TRACE";
  ts: string;
  traceId?: string;
  payload: Record<string, unknown>;
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

const pickFirstNonEmpty = (...values: Array<string | undefined>): string | undefined => {
  for (const value of values) {
    const normalized = value?.trim();
    if (normalized) {
      return normalized;
    }
  }

  return undefined;
};

export const resolveControlBearerToken = (
  env: NodeJS.ProcessEnv = process.env,
): string | undefined => {
  const sharedToken = pickFirstNonEmpty(env.LOCAL_LLM_HUB_AUTH_TOKEN);
  const publicToken = pickFirstNonEmpty(
    env.LOCAL_LLM_HUB_GATEWAY_PUBLIC_BEARER_TOKEN,
    env.GATEWAY_PUBLIC_BEARER_TOKEN,
    sharedToken,
  );

  return pickFirstNonEmpty(
    env.LOCAL_LLM_HUB_GATEWAY_CONTROL_BEARER_TOKEN,
    env.GATEWAY_CONTROL_BEARER_TOKEN,
    publicToken,
    sharedToken,
  );
};

export const buildControlHeaders = (
  controlBearerToken: string | undefined,
  extraHeaders: Record<string, string> = {},
): Record<string, string> =>
  controlBearerToken
    ? {
        ...extraHeaders,
        Authorization: `Bearer ${controlBearerToken}`,
      }
    : extraHeaders;

const toLifecycleState = (
  state: LegacyWorkerState,
): "Loading" | "Ready" | "Busy" | "Unloading" | "Crashed" | "CoolingDown" => {
  if (state === "Idle") {
    return "CoolingDown";
  }

  return state;
};

const buildRuntimeKey = (modelId: string) => ({
  modelId,
  engineType: "llama.cpp",
  role: "chat" as const,
  configHash: "stage1-mock",
});

const formatBytes = (value: number): string => {
  if (value <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let nextValue = value;
  let unitIndex = 0;

  while (nextValue >= 1024 && unitIndex < units.length - 1) {
    nextValue /= 1024;
    unitIndex += 1;
  }

  return `${nextValue >= 10 ? nextValue.toFixed(0) : nextValue.toFixed(1)} ${units[unitIndex]}`;
};

const describeModel = (model: DesktopModelRecord): string => {
  const facets = [model.role, model.format, model.architecture, model.quantization]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.replace(/-/g, " "));

  if (facets.length === 0) {
    return "Registered local model.";
  }

  return facets.join(" • ");
};

const toModelSummary = (model: DesktopModelRecord): PublicModelList["data"][number] => ({
  id: model.id,
  name: model.displayName,
  engine: model.engineType,
  state: model.state,
  sizeLabel: formatBytes(model.sizeBytes),
  tags: model.tags,
  ...(model.contextLength !== undefined ? { contextLength: model.contextLength } : {}),
  description: describeModel(model),
  ...(model.lastUsedAt ? { lastUsedAt: model.lastUsedAt } : {}),
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
    case "POST /control/models/register-local":
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

const toRawWorkerState = (value: unknown): LegacyWorkerState => {
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

const getErrorMessage = (value: unknown, fallback: string): string => {
  if (!value || typeof value !== "object") {
    return fallback;
  }

  const candidate = value as Record<string, unknown>;
  return typeof candidate.message === "string" && candidate.message.trim().length > 0
    ? candidate.message
    : fallback;
};

export class GatewayManager extends EventEmitter {
  private child: ChildProcessByStdio<null, Readable, Readable> | undefined;
  private controlSocket: WebSocket | undefined;
  private discovery: GatewayDiscoveryFile | undefined;
  private stopping = false;
  private readonly controlBearerToken = resolveControlBearerToken();
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
        message: "Desktop shell connected to the live model runtime.",
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
    const library = await this.listModelLibrary();

    return publicModelListSchema.parse({
      object: "list",
      data: library.data.map((model) => toModelSummary(model)),
    });
  }

  async listModelLibrary(): Promise<DesktopModelLibrary> {
    const discovery = this.requireDiscovery();
    const payload = await this.readJsonResponse(
      fetch(`${discovery.controlBaseUrl}/control/models`, {
        headers: this.createControlHeaders(),
      }),
      "Unable to load the desktop model library.",
    );

    return desktopModelLibrarySchema.parse(payload);
  }

  async getHealth(): Promise<GatewayHealthSnapshot> {
    const discovery = this.requireDiscovery();
    const raw = (await this.readJsonResponse(
      fetch(`${discovery.controlBaseUrl}/control/health`, {
        headers: this.createControlHeaders(),
      }),
      "Unable to load gateway health.",
    )) as RawGatewayHealth;

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

  async listEngines(): Promise<DesktopEngineList> {
    const discovery = this.requireDiscovery();
    const payload = await this.readJsonResponse(
      fetch(`${discovery.controlBaseUrl}/control/engines`, {
        headers: this.createControlHeaders(),
      }),
      "Unable to load installed engine versions.",
    );

    return desktopEngineListSchema.parse(payload);
  }

  async registerLocalModel(
    payload: DesktopLocalModelImportRequest,
  ): Promise<DesktopLocalModelImportResponse> {
    const discovery = this.requireDiscovery();
    const json = await this.readJsonResponse(
      fetch(`${discovery.controlBaseUrl}/control/models/register-local`, {
        method: "POST",
        headers: this.createControlHeaders({
          "content-type": "application/json",
        }),
        body: JSON.stringify(payload),
      }),
      "Unable to register the selected local model.",
    );

    return desktopLocalModelImportResponseSchema.parse(json);
  }

  async preloadModel(modelId: string): Promise<void> {
    const discovery = this.requireDiscovery();
    await this.readJsonResponse(
      fetch(`${discovery.controlBaseUrl}/control/models/preload`, {
        method: "POST",
        headers: this.createControlHeaders({
          "content-type": "application/json",
        }),
        body: JSON.stringify({ modelId }),
      }),
      `Unable to preload ${modelId}.`,
    );
  }

  async evictModel(modelId: string): Promise<void> {
    const discovery = this.requireDiscovery();
    await this.readJsonResponse(
      fetch(`${discovery.controlBaseUrl}/control/models/evict`, {
        method: "POST",
        headers: this.createControlHeaders({
          "content-type": "application/json",
        }),
        body: JSON.stringify({ modelId }),
      }),
      `Unable to evict ${modelId}.`,
    );
  }

  async stop(): Promise<void> {
    this.stopping = true;

    if (this.discovery) {
      try {
        await fetch(`${this.discovery.controlBaseUrl}/control/system/shutdown`, {
          method: "POST",
          headers: this.createControlHeaders(),
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

  private createControlHeaders(
    extraHeaders: Record<string, string> = {},
  ): Record<string, string> {
    return buildControlHeaders(this.controlBearerToken, extraHeaders);
  }

  private async readJsonResponse(
    request: Promise<Response>,
    fallbackMessage: string,
  ): Promise<unknown> {
    const response = await request;
    const payload = (await response.json().catch(() => null)) as unknown;

    if (!response.ok) {
      throw new Error(getErrorMessage(payload, fallbackMessage));
    }

    return payload;
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
      const socket = new WebSocket(discovery.websocketUrl, {
        headers: this.createControlHeaders(),
      });
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
