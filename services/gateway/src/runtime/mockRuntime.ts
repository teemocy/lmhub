import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  type DesktopLocalModelImportResponse,
  type DesktopModelRecord,
  type DesktopModelRuntimeState,
  type GatewayEvent,
  gatewayEventSchema,
} from "@localhub/shared-contracts";

import type {
  ControlHealthSnapshot,
  DownloadTaskRecord,
  EngineRecord,
  EvictModelResult,
  GatewayPlane,
  PreloadModelResult,
  RequestTraceRecord,
  RuntimeEventKey,
  RuntimeEventRole,
  RuntimeEventRoute,
  RuntimeEventTrace,
  RuntimeLifecycleState,
  RuntimeModelRecord,
  WorkerState,
} from "../types.js";

type GatewaySubscriber = (event: GatewayEvent) => void;

interface MockGatewayRuntimeOptions {
  telemetryIntervalMs: number;
}

interface ModelStateEventOptions {
  previousState?: WorkerState | undefined;
  reason?: string | undefined;
  traceId?: string | undefined;
}

const DEFAULT_ENGINE_TYPE = "llama.cpp";
const DEFAULT_CONFIG_HASH = "stage1-mock";
const MOCK_RESIDENT_MEMORY_BYTES = 2_147_483_648;
const MOCK_GPU_MEMORY_BYTES = 1_073_741_824;

function toDesktopModelState(state: WorkerState): DesktopModelRuntimeState {
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
}

function createModel(id: string, created: number, capabilities: string[]): RuntimeModelRecord {
  return {
    id,
    object: "model",
    created,
    owned_by: "localhub",
    loaded: false,
    state: "Idle",
    capabilities,
  };
}

function createTraceId(traceId?: string): string {
  return traceId?.trim() || randomUUID();
}

function prettifyModelName(modelId: string): string {
  return (
    modelId
      .split("/")
      .at(-1)
      ?.split("-")
      .map((segment) =>
        segment.length === 0 ? segment : `${segment.charAt(0).toUpperCase()}${segment.slice(1)}`,
      )
      .join(" ") ?? modelId
  );
}

function slugifyFileName(filePath: string): string {
  return path
    .basename(filePath, path.extname(filePath))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function getModelRole(model: RuntimeModelRecord): RuntimeEventRole {
  if (model.capabilities.includes("embeddings") && !model.capabilities.includes("chat")) {
    return "embeddings";
  }

  return "chat";
}

function buildRuntimeKey(modelId: string, role: RuntimeEventRole): RuntimeEventKey {
  return {
    modelId,
    engineType: DEFAULT_ENGINE_TYPE,
    role,
    configHash: DEFAULT_CONFIG_HASH,
  };
}

function getRuntimeKeyForModel(model: RuntimeModelRecord): RuntimeEventKey {
  return buildRuntimeKey(model.id, getModelRole(model));
}

function getRuntimeKeyForLog(modelId?: string, model?: RuntimeModelRecord): RuntimeEventKey {
  if (modelId && model) {
    return getRuntimeKeyForModel(model);
  }

  if (modelId) {
    return buildRuntimeKey(modelId, "tooling");
  }

  return buildRuntimeKey("localhub/system", "tooling");
}

function toLifecycleState(state: WorkerState): RuntimeLifecycleState {
  if (state === "Idle") {
    return "CoolingDown";
  }

  return state;
}

function normalizeTraceMethod(method: string): RuntimeEventTrace["method"] {
  const normalized = method.toUpperCase();

  if (
    normalized === "GET" ||
    normalized === "POST" ||
    normalized === "PUT" ||
    normalized === "PATCH" ||
    normalized === "DELETE"
  ) {
    return normalized;
  }

  return "GET";
}

function mapRequestRoute(method: string, path: string): RuntimeEventRoute | null {
  const normalizedRoute = `${method.toUpperCase()} ${path}`;

  switch (normalizedRoute) {
    case "GET /healthz":
    case "GET /v1/models":
    case "GET /control/health":
    case "GET /control/models":
    case "POST /v1/chat/completions":
    case "POST /v1/embeddings":
    case "POST /control/models/preload":
    case "POST /control/models/evict":
    case "POST /control/models/register-local":
    case "POST /control/system/shutdown":
    case "GET /control/downloads":
    case "POST /control/downloads":
    case "GET /control/engines":
    case "POST /control/engines":
    case "PUT /config/gateway":
      return normalizedRoute;
    default:
      if (method.toUpperCase() === "PUT" && /^\/config\/models\/[^/]+$/.test(path)) {
        return "PUT /config/models/:id";
      }

      return null;
  }
}

const DEFAULT_MODELS: RuntimeModelRecord[] = [
  createModel("localhub/tinyllama-1.1b-chat-q4", 1_717_286_400, ["chat"]),
  createModel("localhub/qwen2.5-7b-instruct-q4", 1_717_372_800, ["chat", "tools"]),
  createModel("localhub/bge-small-en-v1.5", 1_717_459_200, ["embeddings"]),
];

const DEFAULT_DOWNLOADS: DownloadTaskRecord[] = [
  {
    id: "download-demo-1",
    provider: "huggingface",
    modelId: "localhub/qwen2.5-7b-instruct-q4",
    status: "running",
    progress: 42,
  },
];

const DEFAULT_ENGINES: EngineRecord[] = [
  {
    id: "llama.cpp",
    engineType: "llama.cpp",
    version: "mock-0.1.0",
    channel: "stable",
    installed: true,
    active: true,
    binaryPath: "/mock/bin/llama-server",
    compatibilityNotes: "Mock engine record for desktop shell development.",
    installedAt: new Date(1_717_286_400_000).toISOString(),
  },
];

export class MockGatewayRuntime {
  readonly #modelDetails = new Map<string, DesktopModelRecord>();
  readonly #models = new Map<string, RuntimeModelRecord>();
  readonly #subscribers = new Set<GatewaySubscriber>();
  readonly #telemetryIntervalMs: number;
  readonly #startedAt = Date.now();
  readonly #downloads = [...DEFAULT_DOWNLOADS];
  readonly #engines = [...DEFAULT_ENGINES];

  #telemetryTimer: NodeJS.Timeout | undefined;

  constructor(options: MockGatewayRuntimeOptions) {
    this.#telemetryIntervalMs = options.telemetryIntervalMs;

    for (const model of DEFAULT_MODELS) {
      this.#models.set(model.id, structuredClone(model));
      this.#modelDetails.set(model.id, this.createDesktopModelRecord(model.id));
    }
  }

  start(): void {
    if (this.#telemetryTimer) {
      return;
    }

    this.publishLog("info", "Mock gateway runtime started", undefined, undefined, "system");
    for (const model of this.#models.values()) {
      this.publish(this.createModelStateEvent(model, { reason: "Current runtime snapshot." }));
    }

    this.#telemetryTimer = setInterval(() => {
      this.publish(this.createMetricsEvent());
    }, this.#telemetryIntervalMs);
  }

  stop(): void {
    if (this.#telemetryTimer) {
      clearInterval(this.#telemetryTimer);
      this.#telemetryTimer = undefined;
    }

    this.publishLog("info", "Mock gateway runtime stopped", undefined, undefined, "system");
  }

  subscribe(subscriber: GatewaySubscriber, options: { replay?: boolean } = {}): () => void {
    if (options.replay ?? true) {
      for (const model of this.#models.values()) {
        subscriber(this.createModelStateEvent(model, { reason: "Current runtime snapshot." }));
      }
      subscriber(this.createMetricsEvent());
    }

    this.#subscribers.add(subscriber);
    return () => {
      this.#subscribers.delete(subscriber);
    };
  }

  listModels(): Array<Pick<RuntimeModelRecord, "id" | "object" | "created" | "owned_by">> {
    return this.listRuntimeModels().map(({ id, object, created, owned_by }) => ({
      id,
      object,
      created,
      owned_by,
    }));
  }

  listRuntimeModels(): RuntimeModelRecord[] {
    return Array.from(this.#models.values(), (model) => structuredClone(model));
  }

  listDesktopModels(): DesktopModelRecord[] {
    return Array.from(this.#models.keys(), (modelId) => this.getDesktopModelRecord(modelId));
  }

  listDownloads(): DownloadTaskRecord[] {
    return structuredClone(this.#downloads);
  }

  listEngines(): EngineRecord[] {
    return structuredClone(this.#engines);
  }

  getHealthSnapshot(plane: GatewayPlane): ControlHealthSnapshot {
    return {
      status: "ok",
      plane,
      uptimeMs: Date.now() - this.#startedAt,
      loadedModelCount: this.getLoadedModelCount(),
      activeWebSocketClients: this.#subscribers.size,
    };
  }

  registerLocalModel(
    input: Parameters<import("../types.js").GatewayRuntime["registerLocalModel"]>[0],
    traceId?: string,
  ): DesktopLocalModelImportResponse {
    const resolvedPath = path.resolve(input.filePath);
    if (path.extname(resolvedPath).toLowerCase() !== ".gguf") {
      throw new Error(`Expected a .gguf artifact, received ${resolvedPath}.`);
    }

    const slug = slugifyFileName(resolvedPath) || `model-${Date.now()}`;
    const modelId = `localhub/${slug}`;
    const created = !this.#models.has(modelId);

    if (created) {
      this.#models.set(modelId, createModel(modelId, Math.floor(Date.now() / 1000), ["chat"]));
    }

    const detail = {
      ...this.createDesktopModelRecord(modelId, {
        displayName: input.displayName?.trim() || undefined,
        localPath: resolvedPath,
      }),
      updatedAt: new Date().toISOString(),
    };
    this.#modelDetails.set(modelId, detail);

    const model = this.#models.get(modelId);
    if (model) {
      this.publish(this.createModelStateEvent(model, { reason: "Model registered and ready to preload.", traceId }));
    }
    this.publishLog(
      "info",
      created ? `Registered mock local model ${modelId}` : `Updated mock local model ${modelId}`,
      traceId,
      modelId,
      "desktop",
    );

    return {
      created,
      model: this.getDesktopModelRecord(modelId),
    };
  }

  preloadModel(modelId: string, traceId?: string): PreloadModelResult {
    const model = this.getModel(modelId);
    if (!model) {
      throw new Error(`Unknown model: ${modelId}`);
    }

    const alreadyWarm = model.loaded && model.state === "Ready";
    if (alreadyWarm) {
      this.publishLog("info", `Model ${modelId} is already warm`, traceId, modelId);
      return {
        model: structuredClone(model),
        alreadyWarm: true,
      };
    }

    this.transitionModel(model, "Loading", false, traceId, "Model load requested.");
    this.publishLog("info", `Loading model ${modelId}`, traceId, modelId);
    this.transitionModel(model, "Ready", true, traceId, "Model is ready for requests.");

    return {
      model: structuredClone(model),
      alreadyWarm: false,
    };
  }

  evictModel(modelId: string, traceId?: string): EvictModelResult {
    const model = this.getModel(modelId);
    if (!model) {
      throw new Error(`Unknown model: ${modelId}`);
    }

    const wasLoaded = model.loaded;
    if (!wasLoaded) {
      this.publishLog("info", `Model ${modelId} is already cold`, traceId, modelId);
      return {
        model: structuredClone(model),
        wasLoaded: false,
      };
    }

    this.transitionModel(model, "Unloading", true, traceId, "Model eviction requested.");
    this.publishLog("info", `Evicting model ${modelId}`, traceId, modelId);
    this.transitionModel(model, "Idle", false, traceId, "Model was evicted from memory.");

    return {
      model: structuredClone(model),
      wasLoaded: true,
    };
  }

  recordRequestTrace(payload: RequestTraceRecord): void {
    const route = mapRequestRoute(payload.method, payload.path);
    if (!route) {
      return;
    }

    const traceId = createTraceId(payload.requestId);
    const completedAt = new Date().toISOString();
    const receivedAt = new Date(Date.now() - payload.durationMs).toISOString();
    const traceEvent: RuntimeEventTrace = {
      traceId,
      requestId: payload.requestId,
      route,
      method: normalizeTraceMethod(payload.method),
      receivedAt,
      completedAt,
      durationMs: payload.durationMs,
      statusCode: payload.statusCode,
      metadata: {
        path: payload.path,
        plane: payload.plane,
      },
      ...(payload.remoteAddress ? { remoteAddress: payload.remoteAddress } : {}),
    };

    this.publish({
      type: "REQUEST_TRACE",
      ts: completedAt,
      traceId,
      payload: traceEvent,
    });
  }

  private createDesktopModelRecord(
    modelId: string,
    overrides: {
      displayName?: string | undefined;
      localPath?: string | undefined;
    } = {},
  ): DesktopModelRecord {
    const model = this.#models.get(modelId);
    const existing = this.#modelDetails.get(modelId);
    const defaultName = prettifyModelName(modelId);

    return {
      id: modelId,
      name: defaultName,
      displayName: overrides.displayName ?? existing?.displayName ?? defaultName,
      engineType: DEFAULT_ENGINE_TYPE,
      state: toDesktopModelState(model?.state ?? "Idle"),
      loaded: model?.loaded ?? false,
      artifactStatus: "available",
      sizeBytes: existing?.sizeBytes ?? 1_610_612_736,
      format: "gguf",
      capabilities: model?.capabilities ?? existing?.capabilities ?? ["chat"],
      role: getModelRole(model ?? createModel(modelId, Math.floor(Date.now() / 1000), ["chat"])),
      tags: existing?.tags ?? ["mock"],
      localPath: overrides.localPath ?? existing?.localPath ?? `/mock/models/${slugifyFileName(modelId)}.gguf`,
      sourceKind: "local",
      pinned: existing?.pinned ?? false,
      defaultTtlMs: existing?.defaultTtlMs ?? 900_000,
      contextLength: existing?.contextLength ?? 8192,
      quantization: existing?.quantization ?? "Q4_K_M",
      architecture: existing?.architecture ?? "llama",
      tokenizer: existing?.tokenizer ?? "gpt2",
      checksumSha256: existing?.checksumSha256 ?? "mock-checksum",
      engineVersion: this.#engines[0]?.version,
      engineChannel: this.#engines[0]?.channel,
      lastUsedAt: existing?.lastUsedAt,
      createdAt: existing?.createdAt ?? new Date((model?.created ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
      updatedAt: existing?.updatedAt ?? new Date().toISOString(),
      ...(model?.lastError ? { errorMessage: model.lastError } : {}),
    };
  }

  private getDesktopModelRecord(modelId: string): DesktopModelRecord {
    const updated = this.createDesktopModelRecord(modelId);
    this.#modelDetails.set(modelId, updated);
    return updated;
  }

  private getLoadedModelCount(): number {
    return Array.from(this.#models.values()).filter((model) => model.loaded).length;
  }

  private getModel(modelId: string): RuntimeModelRecord | undefined {
    return this.#models.get(modelId);
  }

  private transitionModel(
    model: RuntimeModelRecord,
    state: WorkerState,
    loaded: boolean,
    traceId?: string,
    reason?: string,
  ): void {
    const previousState = model.state;
    model.state = state;
    model.loaded = loaded;
    model.lastError = state === "Crashed" ? reason : undefined;
    this.publish(this.createModelStateEvent(model, { previousState, reason, traceId }));
  }

  private createModelStateEvent(
    model: RuntimeModelRecord,
    options: ModelStateEventOptions = {},
  ): GatewayEvent {
    const traceId = createTraceId(options.traceId);

    return {
      type: "MODEL_STATE_CHANGED",
      ts: new Date().toISOString(),
      traceId,
      payload: {
        modelId: model.id,
        runtimeKey: getRuntimeKeyForModel(model),
        nextState: toLifecycleState(model.state),
        ...(options.previousState
          ? { previousState: toLifecycleState(options.previousState) }
          : {}),
        ...(options.reason ? { reason: options.reason } : {}),
      },
    };
  }

  private createMetricsEvent(): GatewayEvent {
    const activeWorkers = this.getLoadedModelCount();

    return {
      type: "METRICS_TICK",
      ts: new Date().toISOString(),
      traceId: createTraceId(),
      payload: {
        activeWorkers,
        queuedRequests: 0,
        residentMemoryBytes: activeWorkers * MOCK_RESIDENT_MEMORY_BYTES,
        gpuMemoryBytes: activeWorkers * MOCK_GPU_MEMORY_BYTES,
      },
    };
  }

  private publishLog(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    traceId?: string,
    modelId?: string,
    source: "gateway" | "worker" | "desktop" | "system" = "gateway",
  ): void {
    const model = modelId ? this.getModel(modelId) : undefined;

    this.publish({
      type: "LOG_STREAM",
      ts: new Date().toISOString(),
      traceId: createTraceId(traceId),
      payload: {
        runtimeKey: getRuntimeKeyForLog(modelId, model),
        level,
        message,
        source,
      },
    });
  }

  private publish(event: GatewayEvent): void {
    const parsedEvent = gatewayEventSchema.parse(event);

    for (const subscriber of this.#subscribers) {
      subscriber(parsedEvent);
    }
  }
}
