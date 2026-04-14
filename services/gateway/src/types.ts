import type {
  ChatCompletionsRequest,
  ChatCompletionsResponse,
  ChatSession,
  DesktopApiLogList,
  DesktopChatMessageList,
  DesktopChatRunRequest,
  DesktopChatRunResponse,
  DesktopChatSessionList,
  DesktopChatSessionUpsertRequest,
  DesktopDownloadActionResponse,
  DesktopDownloadCreateRequest,
  DesktopDownloadDeleteResponse,
  DesktopDownloadList,
  DesktopEngineInstallRequest,
  DesktopEngineInstallResponse,
  DesktopEngineRecord,
  DesktopLocalModelImportRequest,
  DesktopLocalModelImportResponse,
  DesktopModelConfigUpdateRequest,
  DesktopModelConfigUpdateResponse,
  DesktopModelRecord,
  DesktopProviderCatalogDetailResponse,
  DesktopProviderSearchResult,
  EmbeddingsRequest,
  EmbeddingsResponse,
  OpenAiModelCard,
  RequestRoute,
  RequestTrace,
  RuntimeKey,
  RuntimeRole,
  GatewayEvent as SharedGatewayEvent,
  WorkerLifecycleState,
} from "@localhub/shared-contracts";

export type GatewayPlane = "public" | "control";

export type WorkerState =
  | "Idle"
  | "Loading"
  | "Ready"
  | "Busy"
  | "Unloading"
  | "Crashed"
  | "CoolingDown";

export interface RuntimeModelRecord {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  loaded: boolean;
  state: WorkerState;
  capabilities: string[];
  lastError?: string | undefined;
}

export interface DownloadTaskRecord {
  id: string;
  provider: "huggingface" | "modelscope";
  modelId: string;
  status: "queued" | "running" | "completed";
  progress: number;
}

export type EngineRecord = DesktopEngineRecord;

export type MaybePromise<T> = T | Promise<T>;

export interface ControlHealthSnapshot {
  status: "ok";
  plane: GatewayPlane;
  uptimeMs: number;
  loadedModelCount: number;
  activeWebSocketClients: number;
}

export interface RequestTraceRecord {
  requestId: string;
  plane: GatewayPlane;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  remoteAddress?: string | undefined;
}

export interface PreloadModelResult {
  model: RuntimeModelRecord;
  alreadyWarm: boolean;
}

export interface EvictModelResult {
  model: RuntimeModelRecord;
  wasLoaded: boolean;
}

export interface GatewayExecutionContext {
  traceId: string;
  remoteAddress?: string | undefined;
}

export interface ChatCompletionsStreamResult {
  stream: ReadableStream<Uint8Array>;
  contentType: string;
}

export interface DesktopChatRunStreamResult {
  stream: ReadableStream<Uint8Array>;
  contentType: string;
  session: ChatSession;
  userMessageId: string;
  assistantMessageId: string;
}

export type GatewayEvent = SharedGatewayEvent;
export type RuntimeEventRoute = RequestRoute;
export type RuntimeEventTrace = RequestTrace;
export type RuntimeEventKey = RuntimeKey;
export type RuntimeEventRole = RuntimeRole;
export type RuntimeLifecycleState = WorkerLifecycleState;

export class GatewayRequestError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.name = "GatewayRequestError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface GatewayRuntime {
  start(): MaybePromise<void>;
  stop(): MaybePromise<void>;
  subscribe(subscriber: (event: GatewayEvent) => void, options?: { replay?: boolean }): () => void;
  listModels(): OpenAiModelCard[];
  listRuntimeModels(): RuntimeModelRecord[];
  listDesktopModels(): MaybePromise<DesktopModelRecord[]>;
  listDownloads(): MaybePromise<DesktopDownloadList>;
  listEngines(): EngineRecord[];
  installEngineBinary(
    input: DesktopEngineInstallRequest,
    traceId?: string,
  ): MaybePromise<DesktopEngineInstallResponse>;
  listChatSessions(): MaybePromise<DesktopChatSessionList>;
  listChatMessages(sessionId: string): MaybePromise<DesktopChatMessageList>;
  upsertChatSession(
    input: DesktopChatSessionUpsertRequest,
  ): MaybePromise<DesktopChatSessionList["data"][number]>;
  deleteChatSession(sessionId: string): MaybePromise<boolean>;
  runChat(input: DesktopChatRunRequest, traceId?: string): MaybePromise<DesktopChatRunResponse>;
  runChatStream(
    input: DesktopChatRunRequest,
    traceId?: string,
  ): MaybePromise<DesktopChatRunStreamResult>;
  listRecentApiLogs(limit?: number): MaybePromise<DesktopApiLogList>;
  searchCatalog(query: string): MaybePromise<DesktopProviderSearchResult>;
  getCatalogModel(
    provider: "huggingface" | "modelscope",
    providerModelId: string,
  ): MaybePromise<DesktopProviderCatalogDetailResponse>;
  createDownload(
    input: DesktopDownloadCreateRequest,
    traceId?: string,
  ): MaybePromise<DesktopDownloadActionResponse>;
  pauseDownload(id: string, traceId?: string): MaybePromise<DesktopDownloadActionResponse>;
  resumeDownload(id: string, traceId?: string): MaybePromise<DesktopDownloadActionResponse>;
  deleteDownload(
    id: string,
    options?: { deleteFiles?: boolean },
    traceId?: string,
  ): MaybePromise<DesktopDownloadDeleteResponse>;
  getHealthSnapshot(plane: GatewayPlane): ControlHealthSnapshot;
  registerLocalModel(
    input: DesktopLocalModelImportRequest,
    traceId?: string,
  ): MaybePromise<DesktopLocalModelImportResponse>;
  updateModelConfig(
    modelId: string,
    input: DesktopModelConfigUpdateRequest,
    traceId?: string,
  ): MaybePromise<DesktopModelConfigUpdateResponse>;
  preloadModel(modelId: string, traceId?: string): MaybePromise<PreloadModelResult>;
  evictModel(modelId: string, traceId?: string): MaybePromise<EvictModelResult>;
  createChatCompletion(
    input: ChatCompletionsRequest,
    context: GatewayExecutionContext,
  ): MaybePromise<ChatCompletionsResponse>;
  createChatCompletionStream(
    input: ChatCompletionsRequest,
    context: GatewayExecutionContext,
  ): MaybePromise<ChatCompletionsStreamResult>;
  createEmbeddings(
    input: EmbeddingsRequest,
    context: GatewayExecutionContext,
  ): MaybePromise<EmbeddingsResponse>;
  recordRequestTrace(payload: RequestTraceRecord): void;
}
