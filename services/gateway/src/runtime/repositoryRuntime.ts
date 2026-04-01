import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import type { DatabaseSync } from "node:sqlite";

import {
  DownloadTasksRepository,
  EngineVersionsRepository,
  ModelsRepository,
  type StoredModelRecord,
  openDatabase,
} from "@localhub/db";
import { runtimeKeyToString } from "@localhub/engine-core";
import {
  LlamaCppModelManager,
  createLlamaCppAdapter,
  createLlamaCppHarness,
} from "@localhub/engine-llama";
import { resolveAppPaths } from "@localhub/platform";
import {
  type DesktopLocalModelImportResponse,
  type DesktopModelRecord,
  type DesktopModelRuntimeState,
  type GatewayEvent,
  desktopLocalModelImportRequestSchema,
  gatewayEventSchema,
} from "@localhub/shared-contracts";
import type {
  CapabilitySet,
  ModelArtifact,
  ModelProfile,
} from "@localhub/shared-contracts/foundation-models";
import type { EngineVersionRecord } from "@localhub/shared-contracts/foundation-persistence";

import type {
  ControlHealthSnapshot,
  DownloadTaskRecord,
  EngineRecord,
  EvictModelResult,
  GatewayPlane,
  GatewayRuntime,
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

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../../../../packages/db/migrations");
const DEFAULT_ENGINE_TYPE = "llama.cpp";
const DEFAULT_CONFIG_HASH_LENGTH = 12;
const DEFAULT_LOAD_TIMEOUT_MS = 5_000;
const ENGINE_RECORD_CAPABILITIES: Partial<CapabilitySet> = {
  chat: true,
  embeddings: true,
  streaming: true,
};

interface RepositoryGatewayRuntimeOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  supportRoot?: string;
  telemetryIntervalMs: number;
  defaultModelTtlMs: number;
  preferFakeWorker?: boolean;
  fakeWorkerStartupDelayMs?: number;
}

interface ResolvedModelRecord {
  stored: StoredModelRecord;
  artifact: ModelArtifact;
  profile: ModelProfile;
  runtimeKey: RuntimeEventKey;
  runtimeKeyString: string;
}

interface RuntimeSnapshot {
  loaded: boolean;
  lastError?: string | undefined;
  runtimeKey: RuntimeEventKey;
  state: WorkerState;
  updatedAt: string;
}

interface ManagedWorker {
  artifact: ModelArtifact;
  evictionTimer: NodeJS.Timeout | undefined;
  harness: Awaited<ReturnType<typeof createLlamaCppHarness>>;
  intentionalStop: boolean;
  loadedAt: string;
  profile: ModelProfile;
  runtimeKey: RuntimeEventKey;
  runtimeKeyString: string;
  state: WorkerState;
}

function normalizeTraceId(value: string | undefined): string {
  const normalized =
    value
      ?.trim()
      .replace(/[^A-Za-z0-9._:-]+/g, "-")
      .slice(0, 128) ?? "";

  return normalized.length >= 8 ? normalized : randomUUID();
}

function nowIso(): string {
  return new Date().toISOString();
}

function getModelRole(artifact: ModelArtifact, profile?: ModelProfile): RuntimeEventRole {
  if (profile?.role) {
    return profile.role;
  }

  if (artifact.capabilities.embeddings && !artifact.capabilities.chat) {
    return "embeddings";
  }

  return "chat";
}

function hashConfig(profile: ModelProfile): string {
  return createHash("sha1")
    .update(
      JSON.stringify({
        defaultTtlMs: profile.defaultTtlMs,
        parameterOverrides: profile.parameterOverrides,
        promptCacheKey: profile.promptCacheKey ?? null,
        role: profile.role,
      }),
    )
    .digest("hex")
    .slice(0, DEFAULT_CONFIG_HASH_LENGTH);
}

function createDefaultProfile(artifact: ModelArtifact, defaultModelTtlMs: number): ModelProfile {
  const timestamp = artifact.updatedAt;

  return {
    schemaVersion: artifact.schemaVersion,
    id: `${artifact.id}::default`,
    modelId: artifact.id,
    displayName: artifact.name,
    engineType: DEFAULT_ENGINE_TYPE,
    pinned: false,
    defaultTtlMs: defaultModelTtlMs,
    role: getModelRole(artifact),
    parameterOverrides: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function buildRuntimeKey(artifact: ModelArtifact, profile: ModelProfile): RuntimeEventKey {
  return {
    modelId: artifact.id,
    engineType: profile.engineType,
    role: getModelRole(artifact, profile),
    configHash: hashConfig(profile),
  };
}

function toLifecycleState(state: WorkerState): RuntimeLifecycleState {
  if (state === "Idle") {
    return "CoolingDown";
  }

  return state;
}

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

function isLoadedState(state: WorkerState): boolean {
  return state === "Loading" || state === "Ready" || state === "Busy" || state === "Unloading";
}

function getChannelFromVersion(versionTag: string): EngineRecord["channel"] {
  return versionTag.toLowerCase().includes("nightly") ? "nightly" : "stable";
}

function getCapabilityList(artifact: ModelArtifact): string[] {
  const capabilities: string[] = [];

  if (artifact.capabilities.chat) {
    capabilities.push("chat");
  }
  if (artifact.capabilities.embeddings) {
    capabilities.push("embeddings");
  }
  if (artifact.capabilities.tools) {
    capabilities.push("tools");
  }
  if (artifact.capabilities.streaming) {
    capabilities.push("streaming");
  }
  if (artifact.capabilities.vision) {
    capabilities.push("vision");
  }
  if (artifact.capabilities.audioTranscription) {
    capabilities.push("audio-transcription");
  }
  if (artifact.capabilities.audioSpeech) {
    capabilities.push("audio-speech");
  }
  if (artifact.capabilities.rerank) {
    capabilities.push("rerank");
  }
  if (artifact.capabilities.promptCache) {
    capabilities.push("prompt-cache");
  }

  return capabilities;
}

function getEffectiveContextLength(
  artifact: ModelArtifact,
  profile: ModelProfile,
): number | undefined {
  const override = profile.parameterOverrides.contextLength;
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }

  return artifact.metadata.contextLength;
}

function getCreatedEpochSeconds(artifact: ModelArtifact): number {
  const timestamp = Date.parse(artifact.createdAt);

  if (!Number.isFinite(timestamp)) {
    return Math.floor(Date.now() / 1000);
  }

  return Math.floor(timestamp / 1000);
}

function getArtifactStatus(artifact: ModelArtifact): "available" | "missing" {
  return existsSync(artifact.localPath) ? "available" : "missing";
}

function getMissingArtifactMessage(artifact: ModelArtifact): string {
  return `Local artifact is missing from ${artifact.localPath}.`;
}

function toRuntimeModelRecord(
  stored: StoredModelRecord,
  snapshot?: RuntimeSnapshot,
): RuntimeModelRecord {
  const state = snapshot?.state ?? "Idle";

  return {
    id: stored.artifact.id,
    object: "model",
    created: getCreatedEpochSeconds(stored.artifact),
    owned_by: "localhub",
    loaded: snapshot?.loaded ?? false,
    state,
    capabilities: getCapabilityList(stored.artifact),
    ...(snapshot?.lastError ? { lastError: snapshot.lastError } : {}),
  };
}

function toEngineRecord(record: EngineVersionRecord): EngineRecord {
  return {
    id: `${record.engineType}:${record.versionTag}`,
    engineType: record.engineType,
    version: record.versionTag,
    channel: getChannelFromVersion(record.versionTag),
    installed: true,
    active: record.isActive,
    binaryPath: record.binaryPath,
    installedAt: record.installedAt,
    compatibilityNotes: record.compatibilityNotes,
  };
}

function toDesktopModelRecord(
  stored: StoredModelRecord,
  profile: ModelProfile,
  snapshot: RuntimeSnapshot | undefined,
  engine: EngineVersionRecord | undefined,
): DesktopModelRecord {
  const artifactStatus = getArtifactStatus(stored.artifact);
  const contextLength = getEffectiveContextLength(stored.artifact, profile);
  const errorMessage =
    artifactStatus === "missing" ? getMissingArtifactMessage(stored.artifact) : snapshot?.lastError;

  return {
    id: stored.artifact.id,
    name: stored.artifact.name,
    displayName: profile.displayName,
    engineType: profile.engineType,
    state: toDesktopModelState(snapshot?.state ?? "Idle"),
    loaded: snapshot?.loaded ?? false,
    artifactStatus,
    sizeBytes: stored.artifact.sizeBytes,
    format: stored.artifact.format,
    capabilities: getCapabilityList(stored.artifact),
    role: profile.role,
    tags: stored.artifact.tags,
    localPath: stored.artifact.localPath,
    sourceKind: stored.artifact.source.kind,
    pinned: profile.pinned,
    defaultTtlMs: profile.defaultTtlMs,
    ...(stored.artifact.architecture ? { architecture: stored.artifact.architecture } : {}),
    ...(stored.artifact.quantization ? { quantization: stored.artifact.quantization } : {}),
    ...(contextLength !== undefined ? { contextLength } : {}),
    ...(stored.artifact.metadata.parameterCount !== undefined
      ? { parameterCount: stored.artifact.metadata.parameterCount }
      : {}),
    ...(stored.artifact.metadata.tokenizer
      ? { tokenizer: stored.artifact.metadata.tokenizer }
      : {}),
    ...(stored.artifact.source.checksumSha256
      ? { checksumSha256: stored.artifact.source.checksumSha256 }
      : {}),
    ...(engine
      ? {
          engineVersion: engine.versionTag,
          engineChannel: getChannelFromVersion(engine.versionTag),
        }
      : {}),
    ...(stored.lastLoadedAt ? { lastUsedAt: stored.lastLoadedAt } : {}),
    createdAt: stored.artifact.createdAt,
    updatedAt: stored.artifact.updatedAt,
    ...(errorMessage ? { errorMessage } : {}),
  };
}

function toDownloadRecord(task: {
  id: string;
  provider: "huggingface" | "modelscope" | "manual" | "local" | "unknown";
  modelId?: string | undefined;
  status: "pending" | "downloading" | "paused" | "completed" | "error";
  downloadedBytes: number;
  totalBytes?: number | undefined;
}): DownloadTaskRecord {
  const progress =
    typeof task.totalBytes === "number" && task.totalBytes > 0
      ? Math.min(100, Math.round((task.downloadedBytes / task.totalBytes) * 100))
      : 0;

  return {
    id: task.id,
    provider:
      task.provider === "huggingface" || task.provider === "modelscope"
        ? task.provider
        : "huggingface",
    modelId: task.modelId ?? "unknown",
    status:
      task.status === "downloading"
        ? "running"
        : task.status === "completed"
          ? "completed"
          : "queued",
    progress,
  };
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

function mapRequestRoute(method: string, pathName: string): RuntimeEventRoute | null {
  const route = `${method.toUpperCase()} ${pathName}`;

  switch (route) {
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
      return route;
    default:
      if (method.toUpperCase() === "PUT" && /^\/config\/models\/[^/]+$/.test(pathName)) {
        return "PUT /config/models/:id";
      }

      return null;
  }
}

export class RepositoryGatewayRuntime implements GatewayRuntime {
  readonly #adapter;
  readonly #database: DatabaseSync;
  readonly #defaultModelTtlMs: number;
  readonly #downloadsRepository: DownloadTasksRepository;
  readonly #enginesRepository: EngineVersionsRepository;
  readonly #modelManager: LlamaCppModelManager;
  readonly #modelsRepository: ModelsRepository;
  readonly #startedAt = Date.now();
  readonly #subscribers = new Set<(event: GatewayEvent) => void>();
  readonly #supportRoot: string;
  readonly #telemetryIntervalMs: number;

  #started = false;
  #telemetryTimer: NodeJS.Timeout | undefined;
  #loadPromises = new Map<string, Promise<ManagedWorker>>();
  #modelSnapshots = new Map<string, RuntimeSnapshot>();
  #workers = new Map<string, ManagedWorker>();

  constructor(options: RepositoryGatewayRuntimeOptions) {
    const environment = options.env?.LOCAL_LLM_HUB_ENV as
      | "development"
      | "packaged"
      | "test"
      | undefined;
    const appPaths = resolveAppPaths({
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(environment ? { environment } : {}),
      ...(options.supportRoot ? { supportRoot: options.supportRoot } : {}),
    });
    const { database } = openDatabase({
      filePath: appPaths.databaseFile,
      migrationsDir: MIGRATIONS_DIR,
    });

    this.#database = database;
    this.#supportRoot = appPaths.supportRoot;
    this.#telemetryIntervalMs = options.telemetryIntervalMs;
    this.#defaultModelTtlMs = options.defaultModelTtlMs;
    this.#modelsRepository = new ModelsRepository(database);
    this.#enginesRepository = new EngineVersionsRepository(database);
    this.#downloadsRepository = new DownloadTasksRepository(database);
    this.#adapter = createLlamaCppAdapter({
      supportRoot: this.#supportRoot,
      ...(options.env ? { env: options.env } : {}),
      ...(options.fakeWorkerStartupDelayMs !== undefined
        ? { fakeWorkerStartupDelayMs: options.fakeWorkerStartupDelayMs }
        : {}),
      ...(options.preferFakeWorker !== undefined
        ? { preferFakeWorker: options.preferFakeWorker }
        : {}),
    });
    this.#modelManager = new LlamaCppModelManager({
      supportRoot: this.#supportRoot,
      adapter: this.#adapter,
      modelsRepository: this.#modelsRepository,
      engineVersionsRepository: this.#enginesRepository,
    });
  }

  async start(): Promise<void> {
    if (this.#started) {
      return;
    }

    this.#started = true;
    this.publishLog(
      "info",
      "Repository-backed gateway runtime started.",
      undefined,
      undefined,
      "system",
    );
    this.replayModelSnapshots();

    this.#telemetryTimer = setInterval(() => {
      this.publish(this.createMetricsEvent());
    }, this.#telemetryIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.#telemetryTimer) {
      clearInterval(this.#telemetryTimer);
      this.#telemetryTimer = undefined;
    }

    const activeWorkers = Array.from(this.#workers.values());
    await Promise.allSettled(
      activeWorkers.map((worker) =>
        this.stopWorker(worker, normalizeTraceId(undefined), "Gateway shutdown requested."),
      ),
    );
    this.#workers.clear();
    this.#loadPromises.clear();

    if (this.#started) {
      this.publishLog(
        "info",
        "Repository-backed gateway runtime stopped.",
        undefined,
        undefined,
        "system",
      );
      this.#started = false;
    }

    this.#database.close();
  }

  subscribe(
    subscriber: (event: GatewayEvent) => void,
    options: { replay?: boolean } = {},
  ): () => void {
    if (options.replay ?? true) {
      for (const stored of this.#modelsRepository.list()) {
        const snapshot = this.#modelSnapshots.get(stored.artifact.id);
        subscriber(
          this.createModelStateEvent(stored.artifact, snapshot?.state ?? "Idle", {
            reason: "Current runtime snapshot.",
            runtimeKey:
              snapshot?.runtimeKey ?? buildRuntimeKey(stored.artifact, this.getProfile(stored)),
            traceId: normalizeTraceId(undefined),
          }),
        );
      }

      subscriber(this.createMetricsEvent());
    }

    this.#subscribers.add(subscriber);
    return () => {
      this.#subscribers.delete(subscriber);
    };
  }

  listModels(): Array<Pick<RuntimeModelRecord, "id" | "object" | "created" | "owned_by">> {
    return this.#modelsRepository.list().map((stored) => ({
      id: stored.artifact.id,
      object: "model",
      created: getCreatedEpochSeconds(stored.artifact),
      owned_by: "localhub",
    }));
  }

  listRuntimeModels(): RuntimeModelRecord[] {
    return this.#modelsRepository
      .list()
      .map((stored) => toRuntimeModelRecord(stored, this.#modelSnapshots.get(stored.artifact.id)));
  }

  listDesktopModels(): DesktopModelRecord[] {
    const activeEngines = new Map(
      this.#enginesRepository
        .list()
        .filter((record) => record.isActive)
        .map((record) => [record.engineType, record]),
    );

    return this.#modelsRepository.list().map((stored) => {
      const profile = this.getProfile(stored);

      return toDesktopModelRecord(
        stored,
        profile,
        this.#modelSnapshots.get(stored.artifact.id),
        activeEngines.get(profile.engineType),
      );
    });
  }

  listDownloads(): DownloadTaskRecord[] {
    return this.#downloadsRepository.listActive().map((task) => toDownloadRecord(task));
  }

  listEngines(): EngineRecord[] {
    return this.#enginesRepository.list().map((record) => toEngineRecord(record));
  }

  getHealthSnapshot(plane: GatewayPlane): ControlHealthSnapshot {
    return {
      status: "ok",
      plane,
      uptimeMs: Date.now() - this.#startedAt,
      loadedModelCount: Array.from(this.#modelSnapshots.values()).filter(
        (snapshot) => snapshot.loaded,
      ).length,
      activeWebSocketClients: this.#subscribers.size,
    };
  }

  async registerLocalModel(
    input: Parameters<GatewayRuntime["registerLocalModel"]>[0],
    traceId?: string,
  ): Promise<DesktopLocalModelImportResponse> {
    const parsedInput = desktopLocalModelImportRequestSchema.parse(input);
    const normalizedPath = path.resolve(parsedInput.filePath);
    const existing = this.#modelsRepository
      .list()
      .find((stored) => path.resolve(stored.artifact.localPath) === normalizedPath);
    const normalizedTraceId = normalizeTraceId(traceId);
    const registered = await this.#modelManager.registerLocalModel({
      filePath: parsedInput.filePath,
      ...(parsedInput.displayName ? { displayName: parsedInput.displayName } : {}),
    });
    const stored = this.#modelsRepository.findById(registered.artifact.id);

    if (!stored) {
      throw new Error(`Registered model ${registered.artifact.id} could not be reloaded.`);
    }

    if (!this.#modelSnapshots.has(registered.artifact.id)) {
      this.publish(
        this.createModelStateEvent(registered.artifact, "Idle", {
          reason: "Model registered and ready to preload.",
          runtimeKey: buildRuntimeKey(registered.artifact, registered.profile),
          traceId: normalizedTraceId,
        }),
      );
    }

    this.publishLog(
      "info",
      existing
        ? `Updated local model registration for ${registered.artifact.id}.`
        : `Registered local model ${registered.artifact.id}.`,
      normalizedTraceId,
      registered.artifact.id,
      "desktop",
    );

    const profile = this.getProfile(stored);
    const activeEngine = this.#enginesRepository
      .list()
      .find((record) => record.engineType === profile.engineType && record.isActive);

    return {
      created: !existing,
      model: toDesktopModelRecord(
        stored,
        profile,
        this.#modelSnapshots.get(registered.artifact.id),
        activeEngine,
      ),
    };
  }

  async preloadModel(modelId: string, traceId?: string): Promise<PreloadModelResult> {
    const resolved = this.resolveModelRecord(modelId);
    const existingWorker = this.#workers.get(resolved.runtimeKeyString);

    if (existingWorker && (existingWorker.state === "Ready" || existingWorker.state === "Busy")) {
      this.refreshTtl(existingWorker);
      return {
        model: this.getRuntimeModelById(modelId),
        alreadyWarm: true,
      };
    }

    const existingLoad = this.#loadPromises.get(resolved.runtimeKeyString);
    if (existingLoad) {
      await existingLoad;
      return {
        model: this.getRuntimeModelById(modelId),
        alreadyWarm: false,
      };
    }

    const loadPromise = this.loadWorker(resolved, normalizeTraceId(traceId));
    this.#loadPromises.set(resolved.runtimeKeyString, loadPromise);

    try {
      await loadPromise;
      return {
        model: this.getRuntimeModelById(modelId),
        alreadyWarm: false,
      };
    } finally {
      if (this.#loadPromises.get(resolved.runtimeKeyString) === loadPromise) {
        this.#loadPromises.delete(resolved.runtimeKeyString);
      }
    }
  }

  async evictModel(modelId: string, traceId?: string): Promise<EvictModelResult> {
    const resolved = this.resolveModelRecord(modelId);
    const pendingLoad = this.#loadPromises.get(resolved.runtimeKeyString);

    if (pendingLoad) {
      await pendingLoad.catch(() => undefined);
    }

    const worker = this.#workers.get(resolved.runtimeKeyString);
    if (!worker) {
      return {
        model: this.getRuntimeModelById(modelId),
        wasLoaded: false,
      };
    }

    await this.stopWorker(worker, normalizeTraceId(traceId), "Model was evicted from memory.");

    return {
      model: this.getRuntimeModelById(modelId),
      wasLoaded: true,
    };
  }

  recordRequestTrace(payload: RequestTraceRecord): void {
    const route = mapRequestRoute(payload.method, payload.path);
    if (!route) {
      return;
    }

    const traceId = normalizeTraceId(payload.requestId);
    const completedAt = nowIso();
    const receivedAt = new Date(Date.now() - payload.durationMs).toISOString();

    const eventPayload: RuntimeEventTrace = {
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
      payload: eventPayload,
    });
  }

  private getProfile(stored: StoredModelRecord): ModelProfile {
    return stored.profile ?? createDefaultProfile(stored.artifact, this.#defaultModelTtlMs);
  }

  private getRuntimeModelById(modelId: string): RuntimeModelRecord {
    const stored = this.#modelsRepository.findById(modelId);
    if (!stored) {
      throw new Error(`Unknown model: ${modelId}`);
    }

    return toRuntimeModelRecord(stored, this.#modelSnapshots.get(modelId));
  }

  private replayModelSnapshots(): void {
    for (const stored of this.#modelsRepository.list()) {
      const profile = this.getProfile(stored);
      this.#modelSnapshots.set(stored.artifact.id, {
        loaded: false,
        runtimeKey: buildRuntimeKey(stored.artifact, profile),
        state: "Idle",
        updatedAt: nowIso(),
      });
    }
  }

  private resolveModelRecord(modelId: string): ResolvedModelRecord {
    const stored = this.#modelsRepository.findById(modelId);
    if (!stored) {
      throw new Error(`Unknown model: ${modelId}`);
    }

    const profile = this.getProfile(stored);
    const runtimeKey = buildRuntimeKey(stored.artifact, profile);

    return {
      stored,
      artifact: stored.artifact,
      profile,
      runtimeKey,
      runtimeKeyString: runtimeKeyToString(runtimeKey),
    };
  }

  private async loadWorker(resolved: ResolvedModelRecord, traceId: string): Promise<ManagedWorker> {
    const previousState = this.#modelSnapshots.get(resolved.artifact.id)?.state ?? "Idle";
    this.publish(
      this.createModelStateEvent(resolved.artifact, "Loading", {
        previousState,
        reason: "Model load requested.",
        runtimeKey: resolved.runtimeKey,
        traceId,
      }),
    );

    try {
      if (getArtifactStatus(resolved.artifact) === "missing") {
        throw new Error(getMissingArtifactMessage(resolved.artifact));
      }

      const harness = await createLlamaCppHarness(this.#adapter, {
        artifact: resolved.artifact,
        profile: resolved.profile,
        runtimeKey: resolved.runtimeKey,
        supportRoot: this.#supportRoot,
      });

      const worker: ManagedWorker = {
        artifact: resolved.artifact,
        evictionTimer: undefined,
        harness,
        intentionalStop: false,
        loadedAt: nowIso(),
        profile: resolved.profile,
        runtimeKey: resolved.runtimeKey,
        runtimeKeyString: resolved.runtimeKeyString,
        state: "Loading",
      };

      this.#workers.set(worker.runtimeKeyString, worker);
      this.attachWorkerLogging(worker);
      this.attachWorkerExitListener(worker);
      this.persistEngineRecord(harness.command);

      await Promise.race([
        harness.waitForReady(DEFAULT_LOAD_TIMEOUT_MS),
        new Promise<never>((_, reject) => {
          harness.child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
            reject(
              new Error(
                `Worker exited before readiness (${code ?? "null"}${signal ? `, ${signal}` : ""}).`,
              ),
            );
          });
        }),
      ]);

      worker.loadedAt = nowIso();
      worker.state = "Ready";
      this.#modelsRepository.markLoaded(resolved.artifact.id, worker.loadedAt);
      this.publishLog(
        "info",
        `Model ${resolved.artifact.id} is ready.`,
        traceId,
        resolved.artifact.id,
        "gateway",
      );
      this.publish(
        this.createModelStateEvent(resolved.artifact, "Ready", {
          previousState: "Loading",
          reason: "Model is ready for requests.",
          runtimeKey: resolved.runtimeKey,
          traceId,
        }),
      );
      this.refreshTtl(worker);

      return worker;
    } catch (error) {
      const activeWorker = this.#workers.get(resolved.runtimeKeyString);
      if (activeWorker) {
        activeWorker.intentionalStop = true;
        activeWorker.evictionTimer?.refresh();
        await activeWorker.harness.stop().catch(() => undefined);
        this.#workers.delete(resolved.runtimeKeyString);
      }

      this.publishLog(
        "error",
        error instanceof Error ? error.message : "Worker failed during load.",
        traceId,
        resolved.artifact.id,
        "gateway",
      );
      this.publish(
        this.createModelStateEvent(resolved.artifact, "Crashed", {
          previousState: "Loading",
          reason: error instanceof Error ? error.message : "Worker load failed.",
          runtimeKey: resolved.runtimeKey,
          traceId,
        }),
      );
      throw error;
    }
  }

  private async stopWorker(worker: ManagedWorker, traceId: string, reason: string): Promise<void> {
    if (worker.evictionTimer) {
      clearTimeout(worker.evictionTimer);
      worker.evictionTimer = undefined;
    }

    const previousState = worker.state;
    worker.intentionalStop = true;
    worker.state = "Unloading";
    this.publish(
      this.createModelStateEvent(worker.artifact, "Unloading", {
        previousState,
        reason,
        runtimeKey: worker.runtimeKey,
        traceId,
      }),
    );

    await worker.harness.stop().catch((error: unknown) => {
      this.publishLog(
        "warn",
        error instanceof Error ? error.message : "Worker stop failed.",
        traceId,
        worker.artifact.id,
        "gateway",
      );
    });
    this.#workers.delete(worker.runtimeKeyString);

    this.publish(
      this.createModelStateEvent(worker.artifact, "CoolingDown", {
        previousState: "Unloading",
        reason,
        runtimeKey: worker.runtimeKey,
        traceId,
      }),
    );
    this.#modelSnapshots.set(worker.artifact.id, {
      loaded: false,
      runtimeKey: worker.runtimeKey,
      state: "Idle",
      updatedAt: nowIso(),
    });
  }

  private refreshTtl(worker: ManagedWorker): void {
    if (worker.evictionTimer) {
      clearTimeout(worker.evictionTimer);
      worker.evictionTimer = undefined;
    }

    if (worker.profile.pinned || worker.profile.defaultTtlMs <= 0) {
      return;
    }

    worker.evictionTimer = setTimeout(() => {
      void this.stopWorker(worker, normalizeTraceId(undefined), "Model TTL expired.");
    }, worker.profile.defaultTtlMs);
    worker.evictionTimer.unref?.();
  }

  private attachWorkerLogging(worker: ManagedWorker): void {
    const attach = (
      stream: NodeJS.ReadableStream,
      level: "info" | "error",
      source: "worker" | "system",
    ) => {
      const reader = createInterface({ input: stream });

      reader.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) {
          return;
        }

        let message = trimmed;
        let resolvedLevel = level as "debug" | "info" | "warn" | "error";

        try {
          const parsed = JSON.parse(trimmed) as {
            level?: "debug" | "info" | "warn" | "error";
            phase?: string;
            reason?: string;
          };
          resolvedLevel = parsed.level ?? level;
          message = parsed.phase
            ? parsed.reason
              ? `${parsed.phase}: ${parsed.reason}`
              : `phase=${parsed.phase}`
            : trimmed;
        } catch {}

        this.publishLog(
          resolvedLevel,
          message,
          normalizeTraceId(undefined),
          worker.artifact.id,
          source,
        );
      });
    };

    attach(worker.harness.child.stdout, "info", "worker");
    attach(worker.harness.child.stderr, "error", "worker");
  }

  private attachWorkerExitListener(worker: ManagedWorker): void {
    worker.harness.child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      if (worker.intentionalStop) {
        return;
      }

      if (worker.evictionTimer) {
        clearTimeout(worker.evictionTimer);
        worker.evictionTimer = undefined;
      }

      this.#workers.delete(worker.runtimeKeyString);
      this.publishLog(
        "error",
        `Worker exited unexpectedly (${code ?? "null"}${signal ? `, ${signal}` : ""}).`,
        normalizeTraceId(undefined),
        worker.artifact.id,
        "worker",
      );
      this.publish(
        this.createModelStateEvent(worker.artifact, "Crashed", {
          previousState: worker.state,
          reason: "Worker exited unexpectedly.",
          runtimeKey: worker.runtimeKey,
          traceId: normalizeTraceId(undefined),
        }),
      );
    });
  }

  private persistEngineRecord(command: {
    command: string;
    managedBy: "binary" | "fake-worker";
    versionTag?: string;
  }): void {
    const versionTag = command.versionTag ?? "stage2-runtime";

    this.#enginesRepository.upsert({
      id: `${DEFAULT_ENGINE_TYPE}:${versionTag}`,
      engineType: DEFAULT_ENGINE_TYPE,
      versionTag,
      binaryPath: command.command,
      isActive: true,
      capabilities: ENGINE_RECORD_CAPABILITIES,
      compatibilityNotes:
        command.managedBy === "fake-worker"
          ? "Using the fake llama.cpp worker harness."
          : "Using a resolved llama.cpp binary.",
      installedAt: nowIso(),
    });
    this.#enginesRepository.setActive(DEFAULT_ENGINE_TYPE, `${DEFAULT_ENGINE_TYPE}:${versionTag}`);
  }

  private createModelStateEvent(
    artifact: ModelArtifact,
    state: WorkerState,
    options: {
      previousState?: WorkerState | undefined;
      reason?: string | undefined;
      runtimeKey: RuntimeEventKey;
      traceId: string;
    },
  ): GatewayEvent {
    const event: GatewayEvent = {
      type: "MODEL_STATE_CHANGED",
      ts: nowIso(),
      traceId: options.traceId,
      payload: {
        modelId: artifact.id,
        runtimeKey: options.runtimeKey,
        nextState: toLifecycleState(state),
        ...(options.previousState
          ? { previousState: toLifecycleState(options.previousState) }
          : {}),
        ...(options.reason ? { reason: options.reason } : {}),
      },
    };

    this.#modelSnapshots.set(artifact.id, {
      loaded: isLoadedState(state),
      ...(state === "Crashed" && options.reason ? { lastError: options.reason } : {}),
      runtimeKey: options.runtimeKey,
      state,
      updatedAt: event.ts,
    });

    return event;
  }

  private createMetricsEvent(): GatewayEvent {
    const activeWorkers = Array.from(this.#modelSnapshots.values()).filter(
      (snapshot) => snapshot.loaded,
    ).length;
    const residentMemoryBytes = Array.from(this.#workers.values()).reduce(
      (total, worker) => total + worker.artifact.sizeBytes,
      0,
    );

    return {
      type: "METRICS_TICK",
      ts: nowIso(),
      traceId: normalizeTraceId(undefined),
      payload: {
        activeWorkers,
        queuedRequests: this.#loadPromises.size,
        residentMemoryBytes,
        gpuMemoryBytes: 0,
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
    const runtimeKey =
      modelId && this.#modelSnapshots.get(modelId)?.runtimeKey
        ? this.#modelSnapshots.get(modelId)?.runtimeKey
        : {
            modelId: modelId ?? "localhub/system",
            engineType: DEFAULT_ENGINE_TYPE,
            role: "tooling" as const,
            configHash: "stage2-runtime",
          };

    this.publish({
      type: "LOG_STREAM",
      ts: nowIso(),
      traceId: normalizeTraceId(traceId),
      payload: {
        runtimeKey: runtimeKey as RuntimeEventKey,
        level,
        message,
        source,
      },
    });
  }

  private publish(event: GatewayEvent): void {
    const parsed = gatewayEventSchema.parse(event);

    for (const subscriber of this.#subscribers) {
      subscriber(parsed);
    }
  }
}

export function createRepositoryGatewayRuntime(
  options: RepositoryGatewayRuntimeOptions,
): RepositoryGatewayRuntime {
  return new RepositoryGatewayRuntime(options);
}
