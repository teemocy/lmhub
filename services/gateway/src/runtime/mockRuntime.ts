import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import {
  type ApiLogRecord,
  type ChatCompletionsChunk,
  type ChatCompletionsRequest,
  type ChatCompletionsResponse,
  type ChatMessage,
  type ChatSession,
  type DesktopApiLogList,
  type DesktopChatMessageList,
  type DesktopChatRunRequest,
  type DesktopChatRunResponse,
  type DesktopChatSessionList,
  type DesktopChatSessionUpsertRequest,
  type DesktopDownloadActionResponse,
  type DesktopDownloadCreateRequest,
  type DesktopDownloadList,
  type DesktopEngineInstallRequest,
  type DesktopEngineInstallResponse,
  type DesktopLocalModelImportResponse,
  type DesktopModelConfigUpdateRequest,
  type DesktopModelConfigUpdateResponse,
  type DesktopModelRecord,
  type DesktopModelRuntimeState,
  type DesktopProviderCatalogDetailResponse,
  type DesktopProviderSearchResult,
  type EmbeddingsRequest,
  type EmbeddingsResponse,
  type GatewayEvent,
  type OpenAiModelCard,
  type OpenAiToolCall,
  chatCompletionsChunkSchema,
  gatewayEventSchema,
} from "@localhub/shared-contracts";
import {
  chatContentHasImages,
  countChatContentTokens,
  createChatSessionTitle,
  formatChatContentSummary,
} from "./chat-content.js";

import {
  type ChatCompletionsStreamResult,
  type ControlHealthSnapshot,
  type DesktopChatRunStreamResult,
  type EngineRecord,
  type EvictModelResult,
  type GatewayExecutionContext,
  type GatewayPlane,
  GatewayRequestError,
  type PreloadModelResult,
  type RequestTraceRecord,
  type RuntimeEventKey,
  type RuntimeEventRole,
  type RuntimeEventRoute,
  type RuntimeEventTrace,
  type RuntimeLifecycleState,
  type RuntimeModelRecord,
  type WorkerState,
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
const CAPABILITY_OVERRIDE_KEYS = [
  "chat",
  "embeddings",
  "tools",
  "streaming",
  "vision",
  "audioTranscription",
  "audioSpeech",
  "rerank",
  "promptCache",
] as const;
const CAPABILITY_LABELS = {
  chat: "chat",
  embeddings: "embeddings",
  tools: "tools",
  streaming: "streaming",
  vision: "vision",
  audioTranscription: "audio-transcription",
  audioSpeech: "audio-speech",
  rerank: "rerank",
  promptCache: "prompt-cache",
} as const;
type CapabilityOverrideMap = NonNullable<DesktopModelConfigUpdateRequest["capabilityOverrides"]>;

interface StreamedAssistantAccumulator {
  responseId?: string;
  created?: number;
  model?: string;
  content: string;
  reasoning: string;
  finishReason: string | null;
  toolCalls: OpenAiToolCall[];
  completionTokens?: number;
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

function normalizeCapabilityOverrides(
  overrides: DesktopModelConfigUpdateRequest["capabilityOverrides"],
): CapabilityOverrideMap {
  if (!overrides) {
    return {};
  }

  const normalized: CapabilityOverrideMap = {};
  for (const key of CAPABILITY_OVERRIDE_KEYS) {
    if (typeof overrides[key] === "boolean") {
      normalized[key] = overrides[key];
    }
  }

  return normalized;
}

function applyCapabilityOverridesToLabels(
  capabilities: string[],
  overrides: DesktopModelConfigUpdateRequest["capabilityOverrides"],
): string[] {
  const normalizedOverrides = normalizeCapabilityOverrides(overrides);
  const current = new Set(capabilities);

  for (const key of CAPABILITY_OVERRIDE_KEYS) {
    const label = CAPABILITY_LABELS[key];
    const value = normalizedOverrides[key];
    if (typeof value !== "boolean") {
      continue;
    }

    if (value) {
      current.add(label);
    } else {
      current.delete(label);
    }
  }

  return CAPABILITY_OVERRIDE_KEYS.map((key) => CAPABILITY_LABELS[key]).filter((label) =>
    current.has(label),
  );
}

function createTraceId(traceId?: string): string {
  return traceId?.trim() || randomUUID();
}

function hasRuntimeAffectingModelConfigChanges(
  input: DesktopModelConfigUpdateRequest,
): boolean {
  return (
    input.defaultTtlMs !== undefined ||
    input.contextLength !== undefined ||
    input.gpuLayers !== undefined ||
    input.capabilityOverrides !== undefined
  );
}

function normalizeAssistantContent(content: unknown): ChatMessage["content"] {
  if (typeof content === "string") {
    return content;
  }

  if (content === null || content === undefined) {
    return null;
  }

  if (Array.isArray(content)) {
    return content as ChatMessage["content"];
  }

  return JSON.stringify(content);
}

function getReasoningContent(
  message:
    | {
        reasoning_content?: string | null | undefined;
      }
    | undefined,
): string | undefined {
  if (typeof message?.reasoning_content !== "string") {
    return undefined;
  }

  return message.reasoning_content.length > 0 ? message.reasoning_content : undefined;
}

function buildAssistantMetadata(options: {
  reasoningContent?: string | undefined;
  finishReason?: string | null | undefined;
}): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};

  if (options.reasoningContent && options.reasoningContent.length > 0) {
    metadata.reasoningContent = options.reasoningContent;
  }

  if (options.finishReason) {
    metadata.finishReason = options.finishReason;
  }

  return metadata;
}

function getOptionalNumber(
  value: unknown,
  min?: number,
  max?: number,
): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  if (min !== undefined && value < min) {
    return undefined;
  }

  if (max !== undefined && value > max) {
    return undefined;
  }

  return value;
}

type ChatSettingsMetadata = {
  maxMessagesInContext?: number;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
};

function getChatSettings(metadata: Record<string, unknown> | undefined): ChatSettingsMetadata {
  const rawSettings = metadata?.chatSettings;
  if (!rawSettings || typeof rawSettings !== "object" || Array.isArray(rawSettings)) {
    return {};
  }

  const record = rawSettings as Record<string, unknown>;

  return {
    temperature: getOptionalNumber(record.temperature, 0, 2),
    topP: getOptionalNumber(record.topP ?? record.top_p, 0, 1),
    maxOutputTokens: getOptionalNumber(record.maxOutputTokens, 1),
    maxMessagesInContext: getOptionalNumber(record.maxMessagesInContext, 1),
  };
}

function buildChatCompletionMessages(
  messages: ChatMessage[],
  systemPrompt: string | undefined,
  maxMessagesInContext?: number,
): ChatCompletionsRequest["messages"] {
  const scopedMessages =
    maxMessagesInContext !== undefined ? messages.slice(-maxMessagesInContext) : messages;

  return [
    ...(systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : []),
    ...scopedMessages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
  ];
}

function createStreamedAssistantAccumulator(): StreamedAssistantAccumulator {
  return {
    content: "",
    reasoning: "",
    finishReason: null,
    toolCalls: [],
  };
}

function applyChunkToAccumulator(
  accumulator: StreamedAssistantAccumulator,
  chunk: ChatCompletionsChunk,
): void {
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

  if (chunk.usage?.completion_tokens !== undefined) {
    accumulator.completionTokens = chunk.usage.completion_tokens;
  }
}

function drainSseBuffer(buffer: string, onData: (data: string) => void): string {
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
  if (model.capabilities.includes("rerank")) {
    return "rerank";
  }

  if (model.capabilities.includes("embeddings") && !model.capabilities.includes("chat")) {
    return "embeddings";
  }

  return "chat";
}

function hashCapabilityList(capabilities: string[]): string {
  return createHash("sha1").update(JSON.stringify(capabilities)).digest("hex").slice(0, 12);
}

function buildRuntimeKey(
  modelId: string,
  role: RuntimeEventRole,
  configHash = DEFAULT_CONFIG_HASH,
): RuntimeEventKey {
  return {
    modelId,
    engineType: DEFAULT_ENGINE_TYPE,
    role,
    configHash,
  };
}

function getRuntimeKeyForModel(model: RuntimeModelRecord): RuntimeEventKey {
  return buildRuntimeKey(model.id, getModelRole(model), hashCapabilityList(model.capabilities));
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
    case "PUT /config/gateway":
      return normalizedRoute;
    default:
      if (method.toUpperCase() === "PUT" && /^\/config\/models\/[^/]+$/.test(path)) {
        return "PUT /config/models/:id";
      }

      if (method.toUpperCase() === "DELETE" && /^\/control\/chat\/sessions\/[^/]+$/.test(path)) {
        return "DELETE /control/chat/sessions/:id";
      }

      return null;
  }
}

const DEFAULT_MODELS: RuntimeModelRecord[] = [
  createModel("localhub/tinyllama-1.1b-chat-q4", 1_717_286_400, ["chat"]),
  createModel("localhub/qwen2.5-7b-instruct-q4", 1_717_372_800, ["chat", "tools"]),
  createModel("localhub/qwen2.5-vl-7b-instruct-q4", 1_717_414_400, [
    "chat",
    "tools",
    "vision",
  ]),
  createModel("localhub/bge-small-en-v1.5", 1_717_459_200, ["embeddings"]),
];

const DEFAULT_DOWNLOADS: DesktopDownloadList["data"] = [
  {
    id: "download-demo-1",
    provider: "huggingface",
    title: "Qwen2.5 7B Instruct GGUF",
    artifactName: "qwen2.5-7b-instruct-q4_k_m.gguf",
    modelId: "localhub/qwen2.5-7b-instruct-q4",
    status: "downloading",
    progress: 42,
    downloadedBytes: 420,
    totalBytes: 1_000,
    destinationPath: "/tmp/qwen2.5-7b-instruct-q4_k_m.gguf",
    updatedAt: new Date().toISOString(),
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
  readonly #apiLogs: ApiLogRecord[] = [];
  readonly #chatMessages = new Map<string, ChatMessage[]>();
  readonly #chatSessions = new Map<string, ChatSession>();
  readonly #modelDetails = new Map<string, DesktopModelRecord>();
  readonly #modelBaseCapabilities = new Map<string, string[]>();
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

  listModels(): OpenAiModelCard[] {
    return this.listDesktopModels().map((model) => ({
      id: model.displayName,
      name: model.displayName,
      model_id: model.id,
      object: "model",
      created: Math.floor(Date.parse(model.createdAt) / 1000),
      owned_by: "localhub",
    }));
  }

  listRuntimeModels(): RuntimeModelRecord[] {
    return Array.from(this.#models.values(), (model) => structuredClone(model));
  }

  listDesktopModels(): DesktopModelRecord[] {
    return Array.from(this.#models.keys(), (modelId) => this.getDesktopModelRecord(modelId));
  }

  listDownloads(): DesktopDownloadList {
    return {
      object: "list",
      data: structuredClone(this.#downloads),
    };
  }

  listChatSessions(): DesktopChatSessionList {
    return {
      object: "list",
      data: Array.from(this.#chatSessions.values())
        .map((session) => structuredClone(session))
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
    };
  }

  listChatMessages(sessionId: string): DesktopChatMessageList {
    return {
      object: "list",
      data: structuredClone(this.#chatMessages.get(sessionId) ?? []),
    };
  }

  upsertChatSession(
    input: DesktopChatSessionUpsertRequest,
  ): DesktopChatSessionList["data"][number] {
    const now = new Date().toISOString();
    const existing = input.id ? this.#chatSessions.get(input.id) : undefined;
    const session: ChatSession = {
      id: existing?.id ?? input.id ?? `session_${randomUUID().slice(0, 12)}`,
      ...(input.title !== undefined
        ? { title: input.title }
        : existing?.title
          ? { title: existing.title }
          : {}),
      ...((input.modelId ?? existing?.modelId)
        ? { modelId: input.modelId ?? existing?.modelId }
        : {}),
      ...(input.systemPrompt !== undefined
        ? { systemPrompt: input.systemPrompt }
        : existing?.systemPrompt !== undefined
          ? { systemPrompt: existing.systemPrompt }
          : {}),
      metadata: input.metadata ?? existing?.metadata ?? {},
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.#chatSessions.set(session.id, structuredClone(session));
    if (!this.#chatMessages.has(session.id)) {
      this.#chatMessages.set(session.id, []);
    }

    return structuredClone(session);
  }

  deleteChatSession(sessionId: string): boolean {
    const deleted = this.#chatSessions.delete(sessionId);
    this.#chatMessages.delete(sessionId);

    return deleted;
  }

  runChat(input: DesktopChatRunRequest, traceId?: string): DesktopChatRunResponse {
    const session = this.upsertChatSession({
      ...(input.sessionId ? { id: input.sessionId } : {}),
      modelId: input.model,
      ...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt } : {}),
    });
    const now = new Date().toISOString();
    const chatSettings = getChatSettings(session.metadata);
    const promptTokens = countChatContentTokens(input.message);
    const userMessage: ChatMessage = {
      id: `message_${Date.now()}`,
      sessionId: session.id,
      role: "user",
      content: input.message,
      toolCalls: [],
      tokensCount: promptTokens,
      metadata: {},
      createdAt: now,
    };
    this.#chatMessages.set(session.id, [
      ...(this.#chatMessages.get(session.id) ?? []),
      userMessage,
    ]);
    const response = this.createChatCompletion(
      {
        model: input.model,
        stream: false,
        ...(chatSettings.temperature !== undefined ? { temperature: chatSettings.temperature } : {}),
        ...(chatSettings.topP !== undefined ? { top_p: chatSettings.topP } : {}),
        ...((input.maxTokens ?? chatSettings.maxOutputTokens) !== undefined
          ? { max_tokens: input.maxTokens ?? chatSettings.maxOutputTokens }
          : {}),
        messages: buildChatCompletionMessages(
          this.#chatMessages.get(session.id) ?? [],
          session.systemPrompt,
          chatSettings.maxMessagesInContext,
        ),
      },
      { traceId: createTraceId(traceId) },
    );
    const assistantMessage: ChatMessage = {
      id: `message_${Date.now() + 1}`,
      sessionId: session.id,
      role: "assistant",
      content: normalizeAssistantContent(response.choices[0]?.message.content),
      toolCalls: response.choices[0]?.message.tool_calls ?? [],
      metadata: buildAssistantMetadata({
        reasoningContent: getReasoningContent(response.choices[0]?.message),
        finishReason: response.choices[0]?.finish_reason,
      }),
      createdAt: now,
    };

    this.#chatMessages.set(session.id, [
      ...(this.#chatMessages.get(session.id) ?? []),
      assistantMessage,
    ]);

    const updatedSession = this.upsertChatSession({
      id: session.id,
      modelId: input.model,
      ...(session.systemPrompt !== undefined ? { systemPrompt: session.systemPrompt } : {}),
      ...(session.title ? { title: session.title } : { title: createChatSessionTitle(input.message) }),
    });

    return {
      session: updatedSession,
      userMessage,
      assistantMessage,
      response,
    };
  }

  runChatStream(input: DesktopChatRunRequest, traceId?: string): DesktopChatRunStreamResult {
    const session = this.upsertChatSession({
      ...(input.sessionId ? { id: input.sessionId } : {}),
      modelId: input.model,
      ...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt } : {}),
    });
    const now = new Date().toISOString();
    const chatSettings = getChatSettings(session.metadata);
    const promptTokens = countChatContentTokens(input.message);
    const userMessage: ChatMessage = {
      id: `message_${Date.now()}`,
      sessionId: session.id,
      role: "user",
      content: input.message,
      toolCalls: [],
      tokensCount: promptTokens,
      metadata: {},
      createdAt: now,
    };

    this.#chatMessages.set(session.id, [...(this.#chatMessages.get(session.id) ?? []), userMessage]);

    const assistantMessageId = `message_${Date.now() + 1}`;
    const streamResult = this.createChatCompletionStream(
      {
        model: input.model,
        stream: true,
        ...(chatSettings.temperature !== undefined ? { temperature: chatSettings.temperature } : {}),
        ...(chatSettings.topP !== undefined ? { top_p: chatSettings.topP } : {}),
        ...((input.maxTokens ?? chatSettings.maxOutputTokens) !== undefined
          ? { max_tokens: input.maxTokens ?? chatSettings.maxOutputTokens }
          : {}),
        messages: buildChatCompletionMessages(
          this.#chatMessages.get(session.id) ?? [],
          session.systemPrompt,
          chatSettings.maxMessagesInContext,
        ),
      },
      { traceId: createTraceId(traceId) },
    );
    const accumulator = createStreamedAssistantAccumulator();
    const reader = streamResult.stream.getReader();
    const decoder = new TextDecoder();
    let finalized = false;

    const persistAssistantMessage = () => {
      if (finalized) {
        return;
      }

      finalized = true;
      const assistantMessage: ChatMessage = {
        id: assistantMessageId,
        sessionId: session.id,
        role: "assistant",
        content: accumulator.content.length > 0 ? accumulator.content : null,
        toolCalls: accumulator.toolCalls,
        tokensCount: accumulator.completionTokens,
        metadata: buildAssistantMetadata({
          reasoningContent: accumulator.reasoning,
          finishReason: accumulator.finishReason,
        }),
        createdAt: new Date().toISOString(),
      };

      this.#chatMessages.set(session.id, [
        ...(this.#chatMessages.get(session.id) ?? []),
        assistantMessage,
      ]);
      this.upsertChatSession({
        id: session.id,
        modelId: input.model,
        ...(session.systemPrompt !== undefined ? { systemPrompt: session.systemPrompt } : {}),
        ...(session.title ? { title: session.title } : { title: createChatSessionTitle(input.message) }),
      });
    };

    return {
      contentType: streamResult.contentType,
      session,
      userMessageId: userMessage.id,
      assistantMessageId,
      stream: new ReadableStream<Uint8Array>({
        start: (controller) => {
          let sseBuffer = "";

          void (async () => {
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

                  const parsed = chatCompletionsChunkSchema.safeParse(JSON.parse(data));
                  if (parsed.success) {
                    applyChunkToAccumulator(accumulator, parsed.data);
                  }
                });

                controller.enqueue(value);
              }

              const remaining = decoder.decode();
              if (remaining.length > 0) {
                sseBuffer += remaining;
                sseBuffer = drainSseBuffer(sseBuffer, (data) => {
                  if (data === "[DONE]") {
                    return;
                  }

                  const parsed = chatCompletionsChunkSchema.safeParse(JSON.parse(data));
                  if (parsed.success) {
                    applyChunkToAccumulator(accumulator, parsed.data);
                  }
                });
              }

              persistAssistantMessage();
              controller.close();
            } catch (error) {
              controller.error(error);
            } finally {
              reader.releaseLock();
            }
          })();
        },
        cancel: async (reason) => {
          await reader.cancel(reason).catch(() => undefined);
        },
      }),
    };
  }

  listRecentApiLogs(_limit = 30): DesktopApiLogList {
    return {
      object: "list",
      data: [],
    };
  }

  searchCatalog(query: string): DesktopProviderSearchResult {
    const normalized = query.trim().toLowerCase();
    const item = {
      id: "huggingface:mock/qwen2.5-7b-instruct",
      provider: "huggingface" as const,
      providerModelId: "mock/qwen2.5-7b-instruct",
      title: "Mock Qwen2.5 7B Instruct",
      author: "mock",
      summary: "Fixture provider result from the mock gateway runtime.",
      description: "Fixture provider result from the mock gateway runtime.",
      tags: ["gguf", "chat", "instruct"],
      formats: ["gguf"],
      downloads: 1200,
      likes: 88,
      updatedAt: new Date().toISOString(),
      repositoryUrl: "https://example.invalid/mock/qwen2.5-7b-instruct",
    };

    return {
      object: "list",
      data: normalized.length === 0 || item.title.toLowerCase().includes(normalized) ? [item] : [],
      warnings: [],
    };
  }

  getCatalogModel(
    provider: "huggingface" | "modelscope",
    providerModelId: string,
  ): DesktopProviderCatalogDetailResponse {
    return {
      object: "model",
      data: {
        id: `${provider}:${providerModelId}`,
        provider,
        providerModelId,
        title: "Mock Qwen2.5 7B Instruct",
        author: "mock",
        summary: "Fixture provider result from the mock gateway runtime.",
        description: "Fixture provider result from the mock gateway runtime.",
        tags: ["gguf", "chat", "instruct"],
        formats: ["gguf"],
        downloads: 1200,
        likes: 88,
        updatedAt: new Date().toISOString(),
        repositoryUrl: "https://example.invalid/mock/qwen2.5-7b-instruct",
        variants: [
          {
            id: `${provider}:${providerModelId}:q4_k_m`,
            label: "Q4_K_M",
            primaryArtifactId: "qwen2.5-7b-instruct-q4_k_m",
            files: [
              {
                id: "qwen2.5-7b-instruct-q4_k_m",
                artifactId: "qwen2.5-7b-instruct-q4_k_m",
                artifactName: "qwen2.5-7b-instruct-q4_k_m.gguf",
                sizeBytes: 4_000_000_000,
                quantization: "Q4_K_M",
                architecture: "llama",
                checksumSha256: "a".repeat(64),
                metadata: {},
              },
            ],
            totalSizeBytes: 4_000_000_000,
          },
        ],
      },
      warnings: [],
    };
  }

  createDownload(
    input: DesktopDownloadCreateRequest,
    _traceId?: string,
  ): DesktopDownloadActionResponse {
    const task = {
      id: `download-${Date.now()}`,
      provider: input.provider,
      title: input.title,
      artifactName: input.artifactName,
      status: "pending" as const,
      progress: 0,
      downloadedBytes: 0,
      ...(input.sizeBytes !== undefined ? { totalBytes: input.sizeBytes } : {}),
      ...(input.destinationPath ? { destinationPath: input.destinationPath } : {}),
      updatedAt: new Date().toISOString(),
    };

    this.#downloads.unshift(task);
    return {
      accepted: true,
      task,
    };
  }

  pauseDownload(id: string, _traceId?: string): DesktopDownloadActionResponse {
    const task = this.#downloads.find((entry) => entry.id === id);
    if (!task) {
      throw new Error(`Unknown download: ${id}`);
    }

    task.status = "paused";
    task.updatedAt = new Date().toISOString();
    return {
      accepted: true,
      task: structuredClone(task),
    };
  }

  resumeDownload(id: string, _traceId?: string): DesktopDownloadActionResponse {
    const task = this.#downloads.find((entry) => entry.id === id);
    if (!task) {
      throw new Error(`Unknown download: ${id}`);
    }

    task.status = "downloading";
    task.updatedAt = new Date().toISOString();
    return {
      accepted: true,
      task: structuredClone(task),
    };
  }

  listEngines(): EngineRecord[] {
    return structuredClone(this.#engines);
  }

  installEngineBinary(
    input: DesktopEngineInstallRequest,
    _traceId?: string,
  ): DesktopEngineInstallResponse {
    const versionTag =
      input.action === "download-latest-metal"
        ? "mock-metal-latest"
        : input.action === "import-local-binary"
          ? `mock-local-${slugifyFileName(input.filePath) || "binary"}`
          : input.versionTag;
    const existingRecord = this.#engines.find((record) => record.version === versionTag);
    const binaryName =
      input.action === "download-latest-metal"
        ? "llama-server"
        : input.action === "import-local-binary"
          ? path.basename(input.filePath)
          : existingRecord?.binaryPath
            ? path.basename(existingRecord.binaryPath)
            : "llama-server";
    const binaryPath =
      input.action === "download-latest-metal"
        ? `/mock/support/engines/llama.cpp/versions/${versionTag}/llama-server`
        : input.action === "import-local-binary"
          ? `/mock/support/engines/llama.cpp/versions/${versionTag}/${binaryName}`
          : (existingRecord?.binaryPath ??
            `/mock/support/engines/llama.cpp/versions/${versionTag}/${binaryName}`);
    const engine: EngineRecord = {
      id: `llama.cpp:${versionTag}`,
      engineType: "llama.cpp",
      version: versionTag,
      channel: "stable",
      installed: true,
      active: true,
      binaryPath,
      compatibilityNotes:
        input.action === "download-latest-metal"
          ? "Mock packaged Metal binary install."
          : input.action === "import-local-binary"
            ? `Mock local binary import from ${input.filePath}.`
            : `Mock activated installed version ${input.versionTag}.`,
      installedAt: new Date().toISOString(),
    };

    const existingIndex = this.#engines.findIndex((record) => record.version === versionTag);
    if (existingIndex >= 0) {
      this.#engines.splice(existingIndex, 1, engine);
    } else {
      this.#engines.unshift(engine);
    }

    for (const record of this.#engines) {
      record.active = record.version === versionTag;
    }

    return {
      accepted: true,
      engine: structuredClone(engine),
      notes: [
        input.action === "download-latest-metal"
          ? "Mock downloaded a packaged Metal llama.cpp binary."
          : input.action === "import-local-binary"
            ? `Mock imported local llama.cpp binary from ${input.filePath}.`
            : `Mock activated installed llama.cpp version ${input.versionTag}.`,
      ],
    };
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
    const currentModel = this.#models.get(modelId);
    if (currentModel) {
      this.#models.set(modelId, {
        ...currentModel,
        capabilities: [...detail.capabilities],
      });
    }

    const model = this.#models.get(modelId);
    if (model) {
      this.publish(
        this.createModelStateEvent(model, {
          reason: "Model registered and ready to preload.",
          traceId,
        }),
      );
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

  updateModelConfig(
    modelId: string,
    input: DesktopModelConfigUpdateRequest,
    _traceId?: string,
  ): DesktopModelConfigUpdateResponse {
    const resolvedModelId = this.resolveModelId(modelId);
    if (!resolvedModelId) {
      throw new Error(`Unknown model: ${modelId}`);
    }

    const current = this.getDesktopModelRecord(resolvedModelId);
    if (current.loaded && hasRuntimeAffectingModelConfigChanges(input)) {
      throw new GatewayRequestError(
        "model_config_requires_cold_state",
        "Evict the model from memory before changing advanced runtime settings.",
        409,
      );
    }

    const updated: DesktopModelRecord = {
      ...current,
      ...(input.displayName ? { displayName: input.displayName } : {}),
      ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
      ...(input.defaultTtlMs !== undefined ? { defaultTtlMs: input.defaultTtlMs } : {}),
      ...(input.contextLength !== undefined ? { contextLength: input.contextLength } : {}),
      ...(input.gpuLayers !== undefined ? { gpuLayers: input.gpuLayers } : {}),
      ...(input.capabilityOverrides !== undefined
        ? {
            capabilityOverrides: normalizeCapabilityOverrides(input.capabilityOverrides),
          }
        : {}),
      updatedAt: new Date().toISOString(),
    };
    const baseCapabilities =
      this.#modelBaseCapabilities.get(resolvedModelId) ?? current.capabilities ?? ["chat"];
    updated.capabilities = applyCapabilityOverridesToLabels(
      baseCapabilities,
      updated.capabilityOverrides,
    );
    updated.role = getModelRole(
      createModel(resolvedModelId, Math.floor(Date.now() / 1000), updated.capabilities),
    );
    this.#modelDetails.set(resolvedModelId, updated);
    const runtimeModel = this.#models.get(resolvedModelId);
    if (runtimeModel) {
      this.#models.set(resolvedModelId, {
        ...runtimeModel,
        capabilities: [...updated.capabilities],
      });
    }

    return {
      model: structuredClone(updated),
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

  createChatCompletion(
    input: ChatCompletionsRequest,
    context: GatewayExecutionContext,
  ): ChatCompletionsResponse {
    const model = this.getModel(input.model);
    if (!model) {
      throw new Error(`Unknown model: ${input.model}`);
    }
    if (!model.capabilities.includes("chat")) {
      throw new GatewayRequestError(
        "unsupported_model_capability",
        `Model ${input.model} does not support chat requests.`,
        409,
      );
    }
    if (input.messages.some((message) => chatContentHasImages(message.content))) {
      if (!model.capabilities.includes("vision")) {
        throw new GatewayRequestError(
          "unsupported_model_capability",
          `Model ${input.model} does not support image inputs.`,
          409,
        );
      }
    }

    const created = Math.floor(Date.now() / 1000);
    const lastUserMessage = [...input.messages].reverse().find((message) => message.role === "user");
    const normalizedUserText = formatChatContentSummary(lastUserMessage?.content ?? "");
    const promptTokens = countChatContentTokens(lastUserMessage?.content ?? "");

    this.transitionModel(model, "Busy", true, context.traceId, "Model is serving a request.");

    try {
      if (input.tools?.length) {
        return {
          id: `chatcmpl-${createTraceId(context.traceId)}`,
          object: "chat.completion",
          created,
          model: input.model,
          choices: [
            {
              index: 0,
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: `call-${createTraceId(context.traceId)}`,
                    type: "function",
                    function: {
                      name: input.tools[0]?.function.name ?? "tool",
                      arguments: JSON.stringify({ input: normalizedUserText }),
                    },
                  },
                ],
              },
            },
          ],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: 1,
            total_tokens: promptTokens + 1,
          },
        };
      }

      const answer = `Mock response from ${input.model}: ${normalizedUserText}`;
      const completionTokens = countChatContentTokens(answer);

      return {
        id: `chatcmpl-${createTraceId(context.traceId)}`,
        object: "chat.completion",
        created,
        model: input.model,
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: answer,
            },
          },
        ],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
      };
    } finally {
      this.transitionModel(model, "Ready", true, context.traceId, "Chat completion finished.");
    }
  }

  createChatCompletionStream(
    input: ChatCompletionsRequest,
    context: GatewayExecutionContext,
  ): ChatCompletionsStreamResult {
    const response = this.createChatCompletion({ ...input, stream: false }, context);
    const encoder = new TextEncoder();
    const chunks = [
      `data: ${JSON.stringify({
        id: response.id,
        object: "chat.completion.chunk",
        created: response.created,
        model: response.model,
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      })}\n\n`,
      `data: ${JSON.stringify({
        id: response.id,
        object: "chat.completion.chunk",
        created: response.created,
        model: response.model,
        choices: response.choices[0]?.message.tool_calls
          ? [
              {
                index: 0,
                delta: { tool_calls: response.choices[0].message.tool_calls },
                finish_reason: null,
              },
            ]
          : [
              {
                index: 0,
                delta: { content: response.choices[0]?.message.content ?? "" },
                finish_reason: null,
              },
            ],
      })}\n\n`,
      `data: ${JSON.stringify({
        id: response.id,
        object: "chat.completion.chunk",
        created: response.created,
        model: response.model,
        choices: [
          { index: 0, delta: {}, finish_reason: response.choices[0]?.finish_reason ?? "stop" },
        ],
      })}\n\n`,
      "data: [DONE]\n\n",
    ];

    return {
      contentType: "text/event-stream; charset=utf-8",
      stream: new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        },
      }),
    };
  }

  createEmbeddings(
    input: EmbeddingsRequest,
    _context: GatewayExecutionContext,
  ): EmbeddingsResponse {
    const model = this.getModel(input.model);
    if (!model) {
      throw new Error(`Unknown model: ${input.model}`);
    }
    if (!model.capabilities.includes("embeddings")) {
      throw new GatewayRequestError(
        "unsupported_model_capability",
        `Model ${input.model} does not support embeddings requests.`,
        409,
      );
    }

    const values = Array.isArray(input.input) ? input.input : [input.input];
    return {
      object: "list",
      model: input.model,
      data: values.map((value, index) => ({
        object: "embedding",
        index,
        embedding: Array.from({ length: 8 }, (_, position) =>
          Number((((value.length + 1) * (position + 3)) / 100).toFixed(6)),
        ),
      })),
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
    const baseCapabilities =
      this.#modelBaseCapabilities.get(modelId) ??
      model?.capabilities ??
      existing?.capabilities ??
      ["chat"];
    if (!this.#modelBaseCapabilities.has(modelId)) {
      this.#modelBaseCapabilities.set(modelId, [...baseCapabilities]);
    }

    const capabilityOverrides = normalizeCapabilityOverrides(existing?.capabilityOverrides);
    const capabilities = applyCapabilityOverridesToLabels(baseCapabilities, capabilityOverrides);
    const effectiveModel = model
      ? {
          ...model,
          capabilities,
        }
      : createModel(modelId, Math.floor(Date.now() / 1000), capabilities);

    return {
      id: modelId,
      name: defaultName,
      displayName: overrides.displayName ?? existing?.displayName ?? defaultName,
      engineType: DEFAULT_ENGINE_TYPE,
      state: toDesktopModelState(effectiveModel.state),
      loaded: effectiveModel.loaded,
      artifactStatus: "available",
      sizeBytes: existing?.sizeBytes ?? 1_610_612_736,
      format: "gguf",
      capabilities,
      capabilityOverrides,
      role: getModelRole(effectiveModel),
      tags: existing?.tags ?? ["mock"],
      localPath:
        overrides.localPath ??
        existing?.localPath ??
        `/mock/models/${slugifyFileName(modelId)}.gguf`,
      sourceKind: "local",
      pinned: existing?.pinned ?? false,
      defaultTtlMs: existing?.defaultTtlMs ?? 900_000,
      contextLength: existing?.contextLength ?? 8192,
      gpuLayers: existing?.gpuLayers ?? 20,
      quantization: existing?.quantization ?? "Q4_K_M",
      architecture: existing?.architecture ?? "llama",
      tokenizer: existing?.tokenizer ?? "gpt2",
      checksumSha256: existing?.checksumSha256 ?? "mock-checksum",
      engineVersion: this.#engines[0]?.version,
      engineChannel: this.#engines[0]?.channel,
      lastUsedAt: existing?.lastUsedAt,
      createdAt:
        existing?.createdAt ??
        new Date((model?.created ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
      updatedAt: existing?.updatedAt ?? new Date().toISOString(),
      ...(model?.lastError ? { errorMessage: model.lastError } : {}),
    };
  }

  private getDesktopModelRecord(modelId: string): DesktopModelRecord {
    const resolvedModelId = this.resolveModelId(modelId);
    if (!resolvedModelId) {
      throw new Error(`Unknown model: ${modelId}`);
    }

    const updated = this.createDesktopModelRecord(resolvedModelId);
    this.#modelDetails.set(resolvedModelId, updated);
    return updated;
  }

  private resolveModelId(modelId: string): string | undefined {
    if (this.#models.has(modelId)) {
      return modelId;
    }

    for (const candidateId of this.#models.keys()) {
      const existing = this.#modelDetails.get(candidateId) ?? this.createDesktopModelRecord(candidateId);
      if (existing.displayName === modelId) {
        return candidateId;
      }
    }

    return undefined;
  }

  private getLoadedModelCount(): number {
    return Array.from(this.#models.values()).filter((model) => model.loaded).length;
  }

  private getModel(modelId: string): RuntimeModelRecord | undefined {
    const resolvedModelId = this.resolveModelId(modelId);
    return resolvedModelId ? this.#models.get(resolvedModelId) : undefined;
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
