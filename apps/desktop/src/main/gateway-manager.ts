import { type ChildProcess, type ChildProcessByStdio, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createWriteStream, existsSync, mkdirSync, type WriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import type { Readable } from "node:stream";
import {
  classifyStderrLogLevel,
  readGatewayDiscoveryFile,
  resolveAppPaths,
} from "@localhub/platform";
import {
  type ControlAuthHeaderName,
  type DesktopApiLogList,
  type DesktopChatMessageList,
  type DesktopChatRunRequest,
  type DesktopChatRunResponse,
  type DesktopChatSessionList,
  type DesktopChatSessionUpsertRequest,
  type DesktopChatStreamEvent,
  type DesktopDownloadActionResponse,
  type DesktopDownloadCreateRequest,
  type DesktopDownloadList,
  type DesktopEngineInstallRequest,
  type DesktopEngineInstallResponse,
  type DesktopEngineList,
  type DesktopLocalModelImportRequest,
  type DesktopLocalModelImportResponse,
  type DesktopModelConfigUpdateRequest,
  type DesktopModelConfigUpdateResponse,
  type DesktopModelLibrary,
  type DesktopModelRecord,
  type DesktopProviderCatalogDetailResponse,
  type DesktopProviderSearchResult,
  type DesktopShellState,
  type GatewayDiscoveryFile,
  type GatewayEvent,
  type GatewayHealthSnapshot,
  type OpenAiToolCall,
  type PublicModelList,
  type RequestRoute,
  chatCompletionsChunkSchema,
  chatSessionSchema,
  desktopApiLogListSchema,
  desktopChatMessageListSchema,
  desktopChatRunResponseSchema,
  desktopChatSessionListSchema,
  desktopDownloadActionResponseSchema,
  desktopDownloadListSchema,
  desktopEngineInstallResponseSchema,
  desktopEngineListSchema,
  desktopLocalModelImportResponseSchema,
  desktopModelConfigUpdateResponseSchema,
  desktopModelLibrarySchema,
  desktopProviderCatalogDetailResponseSchema,
  desktopProviderSearchResultSchema,
  desktopShellStateSchema,
  gatewayEventSchema,
  gatewayHealthSnapshotSchema,
  publicModelListSchema,
} from "@localhub/shared-contracts";
import WebSocket, { type RawData } from "ws";

type GatewayManagerEvents = {
  state: (state: DesktopShellState) => void;
  event: (event: GatewayEvent) => void;
  chatStream: (event: DesktopChatStreamEvent) => void;
};

type GatewayLaunchCommand = {
  command: string;
  useElectronRunAsNode: boolean;
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
  logsDir: string;
  sessionLogFile: string;
  discoveryFile: string;
};

export type DesktopRuntimeEnvironment = "development" | "packaged" | "test";

const DEFAULT_GATEWAY_GRACEFUL_EXIT_TIMEOUT_MS = 5_000;
const DEFAULT_GATEWAY_TERM_EXIT_TIMEOUT_MS = 2_000;
const DEFAULT_GATEWAY_KILL_EXIT_TIMEOUT_MS = 1_000;
const DEFAULT_GATEWAY_DISCOVERY_TIMEOUT_MS = 5 * 60_000;

interface StreamedChatAccumulator {
  responseId?: string;
  created?: number;
  model?: string;
  content: string;
  reasoning: string;
  finishReason: string | null;
  toolCalls: OpenAiToolCall[];
}

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

export const waitForChildExit = async (
  child: Pick<ChildProcess, "exitCode" | "signalCode" | "once" | "off">,
  timeoutMs: number,
): Promise<boolean> => {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true;
  }

  return await new Promise<boolean>((resolve) => {
    const handleExit = () => {
      clearTimeout(timeoutId);
      child.off("exit", handleExit);
      resolve(true);
    };

    const timeoutId = setTimeout(() => {
      child.off("exit", handleExit);
      resolve(false);
    }, timeoutMs);

    child.once("exit", handleExit);
  });
};

const pickFirstNonEmpty = (...values: Array<string | undefined>): string | undefined => {
  for (const value of values) {
    const normalized = value?.trim();
    if (normalized) {
      return normalized;
    }
  }

  return undefined;
};

export const resolveDesktopRuntimeEnvironment = (
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): DesktopRuntimeEnvironment => {
  const explicitEnvironment = env.LOCAL_LLM_HUB_ENV;
  if (
    explicitEnvironment === "development" ||
    explicitEnvironment === "packaged" ||
    explicitEnvironment === "test"
  ) {
    return explicitEnvironment;
  }

  return existsSync(path.join(workspaceRoot, "pnpm-workspace.yaml")) ? "development" : "packaged";
};

export const resolveGatewayLaunchCommand = (
  runtimeEnvironment: DesktopRuntimeEnvironment,
  env: NodeJS.ProcessEnv = process.env,
  execPath = process.execPath,
): GatewayLaunchCommand => {
  const nodeExecutable = pickFirstNonEmpty(
    env.LOCAL_LLM_HUB_GATEWAY_NODE_EXECUTABLE,
    env.npm_node_execpath,
  );

  if ((runtimeEnvironment === "development" || runtimeEnvironment === "test") && nodeExecutable) {
    return {
      command: nodeExecutable,
      useElectronRunAsNode: false,
    };
  }

  return {
    command: execPath,
    useElectronRunAsNode: true,
  };
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
  controlAuthToken: string | undefined,
  controlAuthHeaderName: ControlAuthHeaderName,
  extraHeaders: Record<string, string> = {},
): Record<string, string> =>
  controlAuthToken
    ? {
        ...extraHeaders,
        ...(controlAuthHeaderName === "authorization"
          ? { Authorization: `Bearer ${controlAuthToken}` }
          : { [controlAuthHeaderName]: controlAuthToken }),
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
  capabilities: model.capabilities,
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
    case "GET /control/chat/sessions":
    case "GET /control/chat/messages":
    case "POST /control/chat/sessions":
    case "DELETE /control/chat/sessions/:id":
    case "POST /control/chat/run":
    case "POST /control/chat/run/stream":
    case "GET /control/observability/api-logs":
    case "POST /control/system/shutdown":
    case "GET /control/downloads":
    case "POST /control/downloads":
    case "GET /control/engines":
    case "POST /control/engines":
      return signature as RequestRoute;
    default:
      if (method.toUpperCase() === "PUT" && /^\/config\/models\/[^/]+$/.test(pathName)) {
        return "PUT /config/models/:id";
      }
      if (
        method.toUpperCase() === "DELETE" &&
        /^\/control\/chat\/sessions\/[^/]+$/.test(pathName)
      ) {
        return "DELETE /control/chat/sessions/:id";
      }
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

const getReasoningContent = (metadata: Record<string, unknown> | undefined): string | undefined =>
  typeof metadata?.reasoningContent === "string" && metadata.reasoningContent.length > 0
    ? metadata.reasoningContent
    : undefined;

const createStreamedChatAccumulator = (): StreamedChatAccumulator => ({
  content: "",
  reasoning: "",
  finishReason: null,
  toolCalls: [],
});

const applyChunkToAccumulator = (
  accumulator: StreamedChatAccumulator,
  chunk: {
    id: string;
    created: number;
    model: string;
    choices: Array<{
      finish_reason?: string | null | undefined;
      delta: {
        content?: string | null | undefined;
        reasoning_content?: string | null | undefined;
        tool_calls?: OpenAiToolCall[] | undefined;
      };
    }>;
  },
): void => {
  accumulator.responseId ??= chunk.id;
  accumulator.created ??= chunk.created;
  accumulator.model ??= chunk.model;

  const choice = chunk.choices[0];
  if (!choice) {
    return;
  }

  if (typeof choice.delta.content === "string" && choice.delta.content.length > 0) {
    accumulator.content += choice.delta.content;
  }

  if (
    typeof choice.delta.reasoning_content === "string" &&
    choice.delta.reasoning_content.length > 0
  ) {
    accumulator.reasoning += choice.delta.reasoning_content;
  }

  if (choice.delta.tool_calls?.length) {
    accumulator.toolCalls = choice.delta.tool_calls;
  }

  if (choice.finish_reason !== undefined) {
    accumulator.finishReason = choice.finish_reason ?? accumulator.finishReason;
  }
};

const drainSseBuffer = (buffer: string, onData: (data: string) => void): string => {
  let normalized = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  while (true) {
    const boundaryIndex = normalized.indexOf("\n\n");
    if (boundaryIndex < 0) {
      return normalized;
    }

    const rawEvent = normalized.slice(0, boundaryIndex);
    normalized = normalized.slice(boundaryIndex + 2);

    const data = rawEvent
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");

    if (data.length > 0) {
      onData(data);
    }
  }
};

const formatSessionLogTimestamp = (value: Date): string => value.toISOString().replace(/:/g, "-");

export const resolveSessionLogFilePath = (logsDir: string, now = new Date()): string =>
  path.join(
    logsDir,
    `desktop-session-${formatSessionLogTimestamp(now)}-${process.pid}-${randomUUID()}.jsonl`,
  );

export class GatewayManager extends EventEmitter {
  private child: ChildProcessByStdio<null, Readable, Readable> | undefined;
  private controlSocket: WebSocket | undefined;
  private discovery: GatewayDiscoveryFile | undefined;
  private sessionLogStream: WriteStream | undefined;
  private closeSessionLogOnExit = false;
  private stopping = false;
  private readonly getControlAuthHeaderName: () => ControlAuthHeaderName;
  private readonly getControlAuthToken: () => string | undefined;
  private readonly controlBearerToken = resolveControlBearerToken();
  private readonly runtimeEnvironment: DesktopRuntimeEnvironment;
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

  constructor(
    options: {
      getControlAuthHeaderName?: () => ControlAuthHeaderName;
      getControlAuthToken?: () => string | undefined;
      workspaceRootOverride?: string;
    } = {},
  ) {
    super();

    const workspaceRoot =
      options.workspaceRootOverride ?? path.resolve(__dirname, "..", "..", "..");
    this.getControlAuthHeaderName = options.getControlAuthHeaderName ?? (() => "authorization");
    this.getControlAuthToken = options.getControlAuthToken ?? (() => undefined);
    this.runtimeEnvironment = resolveDesktopRuntimeEnvironment(workspaceRoot);
    const appPaths = resolveAppPaths({
      cwd: workspaceRoot,
      environment: this.runtimeEnvironment,
    });

    this.paths = {
      workspaceRoot,
      supportDir: appPaths.supportRoot,
      logsDir: appPaths.logsDir,
      sessionLogFile: resolveSessionLogFilePath(appPaths.logsDir),
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

    this.closeSessionLogOnExit = false;
    this.openSessionLogStream();
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
        message: "Waiting for gateway discovery file. Large local model scans can take a while.",
      });
    });

    this.child.once("exit", (code) => {
      if (this.closeSessionLogOnExit) {
        this.closeSessionLogStream();
      }
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
      const discovery = await this.waitForDiscovery(this.child);
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

  async installEngineBinary(
    payload: DesktopEngineInstallRequest,
  ): Promise<DesktopEngineInstallResponse> {
    const discovery = this.requireDiscovery();
    const json = await this.readJsonResponse(
      fetch(`${discovery.controlBaseUrl}/control/engines`, {
        method: "POST",
        headers: this.createControlHeaders({
          "content-type": "application/json",
        }),
        body: JSON.stringify(payload),
      }),
      "Unable to install the selected llama.cpp binary.",
    );

    return desktopEngineInstallResponseSchema.parse(json);
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

  async updateModelConfig(
    modelId: string,
    payload: DesktopModelConfigUpdateRequest,
  ): Promise<DesktopModelConfigUpdateResponse> {
    const discovery = this.requireDiscovery();
    const json = await this.readJsonResponse(
      fetch(`${discovery.controlBaseUrl}/config/models/${encodeURIComponent(modelId)}`, {
        method: "PUT",
        headers: this.createControlHeaders({
          "content-type": "application/json",
        }),
        body: JSON.stringify(payload),
      }),
      `Unable to update ${modelId} configuration.`,
    );

    return desktopModelConfigUpdateResponseSchema.parse(json);
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

  async listChatSessions(): Promise<DesktopChatSessionList> {
    const discovery = this.requireDiscovery();
    const payload = await this.readJsonResponse(
      fetch(`${discovery.controlBaseUrl}/control/chat/sessions`, {
        headers: this.createControlHeaders(),
      }),
      "Unable to load chat sessions.",
    );

    return desktopChatSessionListSchema.parse(payload);
  }

  async listChatMessages(sessionId: string): Promise<DesktopChatMessageList> {
    const discovery = this.requireDiscovery();
    const encodedId = encodeURIComponent(sessionId);
    const payload = await this.readJsonResponse(
      fetch(`${discovery.controlBaseUrl}/control/chat/messages?sessionId=${encodedId}`, {
        headers: this.createControlHeaders(),
      }),
      "Unable to load chat messages.",
    );

    return desktopChatMessageListSchema.parse(payload);
  }

  async upsertChatSession(
    input: DesktopChatSessionUpsertRequest,
  ): Promise<DesktopChatSessionList["data"][number]> {
    const discovery = this.requireDiscovery();
    const payload = await this.readJsonResponse(
      fetch(`${discovery.controlBaseUrl}/control/chat/sessions`, {
        method: "POST",
        headers: this.createControlHeaders({
          "content-type": "application/json",
        }),
        body: JSON.stringify(input),
      }),
      "Unable to save chat session.",
    );
    return chatSessionSchema.parse(payload);
  }

  async deleteChatSession(sessionId: string): Promise<void> {
    const discovery = this.requireDiscovery();
    const encodedId = encodeURIComponent(sessionId);
    await this.readJsonResponse(
      fetch(`${discovery.controlBaseUrl}/control/chat/sessions/${encodedId}`, {
        method: "DELETE",
        headers: this.createControlHeaders(),
      }),
      "Unable to delete chat session.",
    );
  }

  async runChat(input: DesktopChatRunRequest): Promise<DesktopChatRunResponse> {
    const discovery = this.requireDiscovery();
    const clientRequestId = input.clientRequestId?.trim() || randomUUID();
    const response = await fetch(`${discovery.controlBaseUrl}/control/chat/run/stream`, {
      method: "POST",
      headers: this.createControlHeaders({
        "content-type": "application/json",
      }),
      body: JSON.stringify({
        ...input,
        clientRequestId,
      }),
    });
    const sessionId = response.headers.get("x-localhub-session-id") ?? input.sessionId ?? undefined;

    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as unknown;
      const errorMessage = getErrorMessage(payload, "Unable to run chat request.");
      this.emit("chatStream", {
        type: "error",
        clientRequestId,
        ...(sessionId ? { sessionId } : {}),
        errorMessage,
      });
      throw new Error(errorMessage);
    }

    if (!sessionId) {
      throw new Error("Unable to resolve the chat session for the streamed response.");
    }

    this.emit("chatStream", {
      type: "start",
      clientRequestId,
      sessionId,
    });

    if (!response.body) {
      const errorMessage = "The gateway did not provide a streaming response body.";
      this.emit("chatStream", {
        type: "error",
        clientRequestId,
        sessionId,
        errorMessage,
      });
      throw new Error(errorMessage);
    }

    const accumulator = createStreamedChatAccumulator();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        sseBuffer += decoder.decode(value, { stream: true });
        sseBuffer = drainSseBuffer(sseBuffer, (data) => {
          if (data === "[DONE]") {
            return;
          }

          let parsedJson: unknown;
          try {
            parsedJson = JSON.parse(data);
          } catch {
            return;
          }

          const parsed = chatCompletionsChunkSchema.safeParse(parsedJson);
          if (!parsed.success) {
            return;
          }

          applyChunkToAccumulator(accumulator, parsed.data);
          const choice = parsed.data.choices[0];
          if (!choice) {
            return;
          }

          const contentDelta =
            typeof choice.delta.content === "string" && choice.delta.content.length > 0
              ? choice.delta.content
              : undefined;
          const reasoningDelta =
            typeof choice.delta.reasoning_content === "string" &&
            choice.delta.reasoning_content.length > 0
              ? choice.delta.reasoning_content
              : undefined;
          const toolCalls = choice.delta.tool_calls?.length ? choice.delta.tool_calls : undefined;

          if (!contentDelta && !reasoningDelta && !toolCalls) {
            return;
          }

          this.emit("chatStream", {
            type: "delta",
            clientRequestId,
            sessionId,
            ...(contentDelta ? { contentDelta } : {}),
            ...(reasoningDelta ? { reasoningDelta } : {}),
            ...(toolCalls ? { toolCalls } : {}),
          });
        });
      }

      const remaining = decoder.decode();
      if (remaining.length > 0) {
        sseBuffer += remaining;
        sseBuffer = drainSseBuffer(sseBuffer, (data) => {
          if (data === "[DONE]") {
            return;
          }

          let parsedJson: unknown;
          try {
            parsedJson = JSON.parse(data);
          } catch {
            return;
          }

          const parsed = chatCompletionsChunkSchema.safeParse(parsedJson);
          if (parsed.success) {
            applyChunkToAccumulator(accumulator, parsed.data);
          }
        });
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unable to read the chat stream.";
      this.emit("chatStream", {
        type: "error",
        clientRequestId,
        sessionId,
        errorMessage,
      });
      throw error;
    } finally {
      reader.releaseLock();
    }

    this.emit("chatStream", {
      type: "done",
      clientRequestId,
      sessionId,
    });

    const [sessions, messages] = await Promise.all([
      this.listChatSessions(),
      this.listChatMessages(sessionId),
    ]);
    const userMessageId = response.headers.get("x-localhub-user-message-id") ?? undefined;
    const assistantMessageId = response.headers.get("x-localhub-assistant-message-id") ?? undefined;
    const session =
      sessions.data.find((candidate) => candidate.id === sessionId) ??
      chatSessionSchema.parse({
        id: sessionId,
        modelId: input.model,
        ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        metadata: {},
      });
    const userMessage = (userMessageId
      ? messages.data.find((message) => message.id === userMessageId)
      : undefined) ??
      [...messages.data].reverse().find((message) => message.role === "user") ?? {
        id: userMessageId ?? `message_${clientRequestId}`,
        sessionId,
        role: "user" as const,
        content: input.message,
        toolCalls: [],
        metadata: {},
        createdAt: new Date().toISOString(),
      };
    const assistantMessage = (assistantMessageId
      ? messages.data.find((message) => message.id === assistantMessageId)
      : undefined) ??
      [...messages.data].reverse().find((message) => message.role === "assistant") ?? {
        id: assistantMessageId ?? `message_${clientRequestId}-assistant`,
        sessionId,
        role: "assistant" as const,
        content: accumulator.content.length > 0 ? accumulator.content : null,
        toolCalls: accumulator.toolCalls,
        metadata:
          accumulator.reasoning.length > 0
            ? {
                reasoningContent: accumulator.reasoning,
              }
            : {},
        createdAt: new Date().toISOString(),
      };
    const reasoningContent = getReasoningContent(
      assistantMessage.metadata as Record<string, unknown> | undefined,
    );

    return desktopChatRunResponseSchema.parse({
      session,
      userMessage,
      assistantMessage,
      response: {
        id: accumulator.responseId ?? `chatcmpl-${clientRequestId}`,
        object: "chat.completion",
        created: accumulator.created ?? Math.floor(Date.now() / 1000),
        model: accumulator.model ?? input.model,
        choices: [
          {
            index: 0,
            finish_reason: accumulator.finishReason,
            message: {
              role: "assistant",
              content: assistantMessage.content,
              ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
              ...(assistantMessage.toolCalls.length > 0
                ? { tool_calls: assistantMessage.toolCalls }
                : {}),
            },
          },
        ],
      },
    });
  }

  async listApiLogs(limit = 30): Promise<DesktopApiLogList> {
    const discovery = this.requireDiscovery();
    const payload = await this.readJsonResponse(
      fetch(`${discovery.controlBaseUrl}/control/observability/api-logs?limit=${limit}`, {
        headers: this.createControlHeaders(),
      }),
      "Unable to load API logs.",
    );

    return desktopApiLogListSchema.parse(payload);
  }

  async searchCatalog(query: string): Promise<DesktopProviderSearchResult> {
    const discovery = this.requireDiscovery();
    const encoded = encodeURIComponent(query.trim());
    const payload = await this.readJsonResponse(
      fetch(`${discovery.controlBaseUrl}/control/downloads?q=${encoded}`, {
        headers: this.createControlHeaders(),
      }),
      "Unable to search model catalog.",
    );

    return desktopProviderSearchResultSchema.parse(payload);
  }

  async getCatalogModel(
    provider: "huggingface" | "modelscope",
    providerModelId: string,
  ): Promise<DesktopProviderCatalogDetailResponse> {
    const discovery = this.requireDiscovery();
    const encodedProvider = encodeURIComponent(provider);
    const encodedModelId = encodeURIComponent(providerModelId);
    const payload = await this.readJsonResponse(
      fetch(
        `${discovery.controlBaseUrl}/control/downloads?provider=${encodedProvider}&providerModelId=${encodedModelId}`,
        {
          headers: this.createControlHeaders(),
        },
      ),
      "Unable to load model catalog details.",
    );

    return desktopProviderCatalogDetailResponseSchema.parse(payload);
  }

  async listDownloads(): Promise<DesktopDownloadList> {
    const discovery = this.requireDiscovery();
    const payload = await this.readJsonResponse(
      fetch(`${discovery.controlBaseUrl}/control/downloads`, {
        headers: this.createControlHeaders(),
      }),
      "Unable to load download tasks.",
    );

    return desktopDownloadListSchema.parse(payload);
  }

  async createDownload(
    input: DesktopDownloadCreateRequest,
  ): Promise<DesktopDownloadActionResponse> {
    const discovery = this.requireDiscovery();
    const payload = await this.readJsonResponse(
      fetch(`${discovery.controlBaseUrl}/control/downloads`, {
        method: "POST",
        headers: this.createControlHeaders({
          "content-type": "application/json",
        }),
        body: JSON.stringify(input),
      }),
      "Unable to create download task.",
    );

    return desktopDownloadActionResponseSchema.parse(payload);
  }

  async pauseDownload(id: string): Promise<DesktopDownloadActionResponse> {
    const discovery = this.requireDiscovery();
    const payload = await this.readJsonResponse(
      fetch(`${discovery.controlBaseUrl}/control/downloads`, {
        method: "POST",
        headers: this.createControlHeaders({
          "content-type": "application/json",
        }),
        body: JSON.stringify({ action: "pause", id }),
      }),
      "Unable to pause download task.",
    );

    return desktopDownloadActionResponseSchema.parse(payload);
  }

  async resumeDownload(id: string): Promise<DesktopDownloadActionResponse> {
    const discovery = this.requireDiscovery();
    const payload = await this.readJsonResponse(
      fetch(`${discovery.controlBaseUrl}/control/downloads`, {
        method: "POST",
        headers: this.createControlHeaders({
          "content-type": "application/json",
        }),
        body: JSON.stringify({ action: "resume", id }),
      }),
      "Unable to resume download task.",
    );

    return desktopDownloadActionResponseSchema.parse(payload);
  }

  async stop(options: { preserveSessionLog?: boolean } = {}): Promise<void> {
    const preserveSessionLog = options.preserveSessionLog ?? false;
    this.stopping = true;
    this.closeSessionLogOnExit = !preserveSessionLog;
    this.controlSocket?.close();
    this.controlSocket = undefined;

    const child = this.child;
    if (!child) {
      this.discovery = undefined;
      if (!preserveSessionLog) {
        this.closeSessionLogStream();
      }
      return;
    }

    let exited = false;

    if (this.discovery) {
      try {
        await fetch(`${this.discovery.controlBaseUrl}/control/system/shutdown`, {
          method: "POST",
          headers: this.createControlHeaders(),
        });
        exited = await waitForChildExit(child, DEFAULT_GATEWAY_GRACEFUL_EXIT_TIMEOUT_MS);
      } catch {
        /* noop */
      }
    }

    if (!exited) {
      child.kill("SIGTERM");
      exited = await waitForChildExit(child, DEFAULT_GATEWAY_TERM_EXIT_TIMEOUT_MS);
    }

    if (!exited) {
      child.kill("SIGKILL");
      exited = await waitForChildExit(child, DEFAULT_GATEWAY_KILL_EXIT_TIMEOUT_MS);
    }

    this.discovery = undefined;
    if (!preserveSessionLog) {
      this.closeSessionLogStream();
    }

    if (!exited) {
      throw new Error("Gateway process did not exit after the shutdown request.");
    }
  }

  async shutdown(): Promise<void> {
    await this.stop();
  }

  async restart(): Promise<void> {
    await this.stop({ preserveSessionLog: true });
    this.stopping = false;
    this.discovery = undefined;
    await this.start();
  }

  private requireDiscovery(): GatewayDiscoveryFile {
    if (!this.discovery) {
      throw new Error("Gateway discovery is not available yet.");
    }

    return this.discovery;
  }

  private createControlHeaders(extraHeaders: Record<string, string> = {}): Record<string, string> {
    return buildControlHeaders(
      this.getControlAuthToken() ?? this.controlBearerToken,
      this.getControlAuthHeaderName(),
      extraHeaders,
    );
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
    const launch = resolveGatewayLaunchCommand(this.runtimeEnvironment);
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      LOCAL_LLM_HUB_APP_SUPPORT_DIR: this.paths.supportDir,
      LOCAL_LLM_HUB_ENV: this.runtimeEnvironment,
    };

    if (launch.useElectronRunAsNode) {
      childEnv.ELECTRON_RUN_AS_NODE = "1";
    } else {
      childEnv.ELECTRON_RUN_AS_NODE = undefined;
    }

    return spawn(launch.command, [gatewayEntry], {
      cwd: this.paths.workspaceRoot,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  private attachProcessLogging(child: ChildProcessByStdio<null, Readable, Readable>): void {
    const emitLog = (sourceLabel: string, streamName: "stdout" | "stderr", chunk: Buffer) => {
      const lines = chunk
        .toString("utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

      for (const message of lines) {
        const level = streamName === "stderr" ? classifyStderrLogLevel(message) : "info";

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
      emitLog("gateway", "stdout", chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      emitLog("gateway", "stderr", chunk);
    });
  }

  private async waitForDiscovery(
    child: Pick<ChildProcess, "exitCode" | "signalCode">,
    timeoutMs = DEFAULT_GATEWAY_DISCOVERY_TIMEOUT_MS,
  ): Promise<GatewayDiscoveryFile> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const discovery = readGatewayDiscoveryFile(this.paths.discoveryFile);
      if (discovery) {
        return discovery;
      }

      if (child.exitCode !== null || child.signalCode !== null) {
        const exitLabel =
          child.exitCode !== null
            ? `code ${child.exitCode}`
            : child.signalCode !== null
              ? `signal ${child.signalCode}`
              : "unknown status";
        throw new Error(`Gateway process exited before writing the discovery file (${exitLabel}).`);
      }

      await sleep(250);
    }

    throw new Error(
      "Timed out waiting for gateway discovery file. Large local model scans can delay startup.",
    );
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
    this.appendSessionLog(parsed);
    this.stateValue.lastEventAt = parsed.ts;
    this.emit("event", parsed);
    this.emit("state", this.getState());
  }

  private openSessionLogStream(): void {
    if (this.sessionLogStream) {
      return;
    }

    mkdirSync(this.paths.logsDir, { recursive: true });
    const stream = createWriteStream(this.paths.sessionLogFile, {
      flags: "a",
      encoding: "utf8",
    });
    stream.on("error", (error: Error) => {
      this.updateState({
        lastError: `Unable to write session logs: ${error.message}`,
      });
      this.closeSessionLogStream();
    });
    this.sessionLogStream = stream;
  }

  private closeSessionLogStream(): void {
    if (!this.sessionLogStream) {
      return;
    }

    this.sessionLogStream.end();
    this.sessionLogStream = undefined;
  }

  private appendSessionLog(event: GatewayEvent): void {
    if (!this.sessionLogStream) {
      return;
    }

    if (event.type !== "LOG_STREAM" && event.type !== "REQUEST_TRACE") {
      return;
    }

    this.sessionLogStream.write(`${JSON.stringify(event)}\n`);
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
