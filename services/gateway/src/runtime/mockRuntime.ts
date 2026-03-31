import { randomUUID } from "node:crypto";

import { type GatewayEvent, gatewayEventSchema } from "@localhub/shared-contracts";

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
    version: "mock-0.1.0",
    channel: "stable",
    installed: true,
  },
];

export class MockGatewayRuntime {
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
