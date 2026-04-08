import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import type { DatabaseSync } from "node:sqlite";

import {
  ChatRepository,
  DownloadTasksRepository,
  EngineVersionsRepository,
  ModelsRepository,
  PromptCachesRepository,
  type StoredModelRecord,
  openDatabase,
} from "@localhub/db";
import { runtimeKeyToString } from "@localhub/engine-core";
import {
  LlamaCppDownloadManager,
  LlamaCppModelManager,
  type ProviderSearchService,
  createDefaultProviderSearchService,
  createLlamaCppAdapter,
  createLlamaCppHarness,
} from "@localhub/engine-llama";
import { classifyStderrLogLevel, resolveAppPaths } from "@localhub/platform";
import {
  type ChatCompletionsChunk,
  type ChatCompletionsRequest,
  type ChatCompletionsResponse,
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
  chatCompletionsResponseSchema,
  desktopApiLogListSchema,
  desktopChatMessageListSchema,
  desktopChatRunResponseSchema,
  desktopChatSessionListSchema,
  desktopDownloadActionResponseSchema,
  desktopDownloadListSchema,
  desktopEngineInstallResponseSchema,
  desktopLocalModelImportRequestSchema,
  desktopModelConfigUpdateResponseSchema,
  embeddingsResponseSchema,
  gatewayEventSchema,
} from "@localhub/shared-contracts";
import type {
  CapabilitySet,
  FlashAttentionType,
  ModelArtifact,
  ModelProfile,
} from "@localhub/shared-contracts/foundation-models";
import type {
  ChatMessage,
  ChatSession,
  EngineVersionRecord,
} from "@localhub/shared-contracts/foundation-persistence";
import type {
  ProviderArtifactDescriptor,
  ProviderId,
  ProviderModelSummary,
} from "@localhub/shared-contracts/foundation-providers";

import {
  type ChatCompletionsStreamResult,
  type ControlHealthSnapshot,
  type DesktopChatRunStreamResult,
  type DownloadTaskRecord,
  type EngineRecord,
  type EvictModelResult,
  type GatewayExecutionContext,
  type GatewayPlane,
  GatewayRequestError,
  type GatewayRuntime,
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
import {
  chatContentHasImages,
  countChatContentTokens,
  createChatSessionTitle,
  estimateTextTokens,
  formatChatContentSummary,
} from "./chat-content.js";

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../../../../packages/db/migrations");
const DEFAULT_ENGINE_TYPE = "llama.cpp";
const DEFAULT_CONFIG_HASH_LENGTH = 12;
const DEFAULT_UBATCH_SIZE = 512;
const DEFAULT_BATCH_SIZE = 3_072;
// Real `llama-server` startups can take a while on large GGUFs, so keep the
// readiness window generous enough for local model loads.
const DEFAULT_LOAD_TIMEOUT_MS = 60_000;
const DEFAULT_STREAM_HEARTBEAT_MS = 15_000;
const DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS = 1_500;
const DEFAULT_WORKER_STOP_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_RESIDENT_MEMORY_BYTES = 0;
const DEFAULT_MAX_WORKERS_PER_MODEL = 2;
const DEFAULT_FAILURE_BACKOFF_MS = 250;
const DEFAULT_FAILURE_BACKOFF_MAX_MS = 2_000;
const DEFAULT_FAILURE_WINDOW_MS = 60_000;
const DEFAULT_CIRCUIT_BREAKER_THRESHOLD = 3;
const DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS = 30_000;
const ENGINE_RECORD_CAPABILITIES: Partial<CapabilitySet> = {
  chat: true,
  embeddings: true,
  streaming: true,
};
const CAPABILITY_OVERRIDE_KEYS: Array<Exclude<keyof CapabilitySet, "promptCache">> = [
  "chat",
  "embeddings",
  "vision",
  "audioTranscription",
  "audioSpeech",
  "rerank",
  "tools",
  "streaming",
];
type CapabilityOverrides = NonNullable<ModelProfile["capabilityOverrides"]>;
const QUANTIZATION_TOKEN_PATTERN =
  /^(?:Q\d(?:_[A-Z0-9]+)*|IQ\d(?:_[A-Z0-9]+)*|BF16|F16|F32|FP16|FP32|NF4)$/i;
const SHARD_SUFFIX_PATTERN = /^(.*?)-(\d{5})-of-(\d{5})$/i;
const AUXILIARY_GGUF_PATTERN = /^mmproj(?:[-_.]|$)/i;

interface StreamedAssistantAccumulator {
  responseId?: string;
  created?: number;
  model?: string;
  content: string;
  reasoning: string;
  finishReason: string | null;
  toolCalls: OpenAiToolCall[];
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

type ChatSettingsMetadata = {
  maxMessagesInContext?: number;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
};

interface CatalogVariantArtifact {
  artifact: ProviderArtifactDescriptor;
  auxiliary: boolean;
  baseModelName: string;
  basename: string;
  quantizationLabel: string;
  shardIndex?: number;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeQuantLabel(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const token = value.trim().replace(/\.gguf$/i, "");
  return QUANTIZATION_TOKEN_PATTERN.test(token) ? token.toUpperCase() : undefined;
}

function extractTrailingQuantization(stem: string): string | undefined {
  const match =
    /(?:^|[-_])((?:IQ\d(?:_[A-Z0-9]+)*|Q\d(?:_[A-Z0-9]+)*|BF16|F16|F32|FP16|FP32|NF4))$/i.exec(
      stem,
    );
  return normalizeQuantLabel(match?.[1]);
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

function getChatSettings(metadata: Record<string, unknown> | undefined): ChatSettingsMetadata {
  const rawSettings = metadata?.chatSettings;
  if (!rawSettings || typeof rawSettings !== "object" || Array.isArray(rawSettings)) {
    return {};
  }

  const record = rawSettings as Record<string, unknown>;
  const temperature = getOptionalNumber(record.temperature, 0, 2);
  const topP = getOptionalNumber(record.topP ?? record.top_p, 0, 1);
  const maxOutputTokens = getOptionalNumber(record.maxOutputTokens, 1);
  const maxMessagesInContext = getOptionalNumber(record.maxMessagesInContext, 1);

  return {
    ...(temperature !== undefined ? { temperature } : {}),
    ...(topP !== undefined ? { topP } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(maxMessagesInContext !== undefined ? { maxMessagesInContext } : {}),
  };
}

function buildChatCompletionMessages(
  chatRepository: ChatRepository,
  sessionId: string,
  systemPrompt: string | undefined,
  maxMessagesInContext?: number,
): ChatCompletionsRequest["messages"] {
  const messages = chatRepository.listMessages(sessionId);
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

function stripTrailingToken(value: string, token: string | undefined): string {
  if (!token) {
    return value;
  }

  return value.replace(new RegExp(`(?:[-_])${escapeRegExp(token)}$`, "i"), "");
}

function toCatalogVariantArtifact(artifact: ProviderArtifactDescriptor): CatalogVariantArtifact {
  const normalizedPath = artifact.fileName.replace(/\\/g, "/");
  const pathSegments = normalizedPath.split("/").filter((segment) => segment.length > 0);
  const basename = pathSegments.at(-1) ?? artifact.fileName;
  const stem = basename.replace(/\.gguf$/i, "");
  const shardMatch = SHARD_SUFFIX_PATTERN.exec(stem);
  const shardlessStem = shardMatch?.[1] ?? stem;
  const directoryHint = pathSegments.length > 1 ? pathSegments[pathSegments.length - 2] : undefined;
  const quantizationLabel =
    normalizeQuantLabel(artifact.quantization) ??
    normalizeQuantLabel(directoryHint) ??
    extractTrailingQuantization(shardlessStem) ??
    "Default";
  const baseModelName = stripTrailingToken(
    shardlessStem.replace(/(?:[-_])gguf$/i, ""),
    quantizationLabel === "Default" ? undefined : quantizationLabel,
  );

  return {
    artifact,
    auxiliary: AUXILIARY_GGUF_PATTERN.test(basename),
    baseModelName: baseModelName || shardlessStem,
    basename,
    quantizationLabel,
    ...(shardMatch?.[2] ? { shardIndex: Number(shardMatch[2]) } : {}),
  };
}

function compareCatalogVariantArtifacts(
  left: CatalogVariantArtifact,
  right: CatalogVariantArtifact,
): number {
  if (left.auxiliary !== right.auxiliary) {
    return left.auxiliary ? 1 : -1;
  }

  const leftShardIndex = left.shardIndex ?? 1;
  const rightShardIndex = right.shardIndex ?? 1;
  if (leftShardIndex !== rightShardIndex) {
    return leftShardIndex - rightShardIndex;
  }

  return left.basename.localeCompare(right.basename);
}

function toCatalogVariantTotalSize(files: CatalogVariantArtifact[]): number | undefined {
  if (files.some((file) => file.artifact.sizeBytes === undefined)) {
    return undefined;
  }

  return files.reduce((total, file) => total + (file.artifact.sizeBytes ?? 0), 0);
}

function toDesktopProviderSearchItem(
  item: ProviderModelSummary,
): DesktopProviderSearchResult["data"][number] {
  return {
    id: `${item.provider}:${item.providerModelId}`,
    provider: item.provider,
    providerModelId: item.providerModelId,
    title: item.title,
    ...(item.author ? { author: item.author } : {}),
    ...(item.description ? { summary: item.description } : {}),
    ...(item.description ? { description: item.description } : {}),
    tags: item.tags,
    formats: item.formats,
    ...(item.downloads !== undefined ? { downloads: item.downloads } : {}),
    ...(item.likes !== undefined ? { likes: item.likes } : {}),
    ...(item.updatedAt ? { updatedAt: item.updatedAt } : {}),
    repositoryUrl: item.repositoryUrl,
  };
}

function toDesktopProviderCatalogDetail(
  item: ProviderModelSummary,
): DesktopProviderCatalogDetailResponse["data"] {
  const baseGroups = new Map<
    string,
    {
      baseModelName: string;
      auxiliaryFiles: CatalogVariantArtifact[];
      variants: Map<string, CatalogVariantArtifact[]>;
    }
  >();

  for (const artifact of item.artifacts) {
    const file = toCatalogVariantArtifact(artifact);
    const baseKey = file.baseModelName.toLowerCase();
    const baseGroup = baseGroups.get(baseKey) ?? {
      baseModelName: file.baseModelName,
      auxiliaryFiles: [],
      variants: new Map<string, CatalogVariantArtifact[]>(),
    };
    if (!baseGroups.has(baseKey)) {
      baseGroups.set(baseKey, baseGroup);
    }

    if (file.auxiliary) {
      baseGroup.auxiliaryFiles.push(file);
      continue;
    }

    const variantKey = file.quantizationLabel.toLowerCase();
    const variantFiles = baseGroup.variants.get(variantKey) ?? [];
    variantFiles.push(file);
    baseGroup.variants.set(variantKey, variantFiles);
  }

  const multipleBaseGroups = baseGroups.size > 1;
  const variants: DesktopProviderCatalogDetailResponse["data"]["variants"] = [];

  for (const baseGroup of baseGroups.values()) {
    for (const [variantKey, modelFiles] of baseGroup.variants.entries()) {
      const auxiliaryFiles = baseGroup.auxiliaryFiles.filter((file) => {
        if (file.quantizationLabel.toLowerCase() === variantKey) {
          return true;
        }

        return baseGroup.auxiliaryFiles.length === 1 && baseGroup.variants.size === 1;
      });
      const files = [...modelFiles, ...auxiliaryFiles].sort(compareCatalogVariantArtifacts);
      const primary = files.find((file) => !file.auxiliary) ?? files[0];
      if (!primary) {
        continue;
      }

      const totalSizeBytes = toCatalogVariantTotalSize(files);
      const label = multipleBaseGroups
        ? primary.quantizationLabel === "Default"
          ? baseGroup.baseModelName
          : `${baseGroup.baseModelName} / ${primary.quantizationLabel}`
        : primary.quantizationLabel;

      variants.push({
        id: `${item.provider}:${item.providerModelId}:${baseGroup.baseModelName.toLowerCase()}:${variantKey}`,
        label,
        primaryArtifactId: primary.artifact.artifactId,
        files: files.map((file) => ({
          id: file.artifact.artifactId,
          artifactId: file.artifact.artifactId,
          artifactName: file.artifact.fileName,
          ...(file.artifact.sizeBytes !== undefined ? { sizeBytes: file.artifact.sizeBytes } : {}),
          ...(file.artifact.quantization ? { quantization: file.artifact.quantization } : {}),
          ...(file.artifact.architecture ? { architecture: file.artifact.architecture } : {}),
          ...(file.artifact.checksum?.algorithm === "sha256"
            ? { checksumSha256: file.artifact.checksum.value }
            : {}),
          metadata: file.artifact.metadata ?? {},
        })),
        ...(totalSizeBytes !== undefined ? { totalSizeBytes } : {}),
      });
    }
  }

  variants.sort((left, right) => {
    const leftSize = left.totalSizeBytes ?? 0;
    const rightSize = right.totalSizeBytes ?? 0;
    if (leftSize !== rightSize) {
      return rightSize - leftSize;
    }

    return left.label.localeCompare(right.label);
  });

  return {
    ...toDesktopProviderSearchItem(item),
    variants,
  };
}

interface RepositoryGatewayRuntimeOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  supportRoot?: string;
  localModelsDir: string;
  telemetryIntervalMs: number;
  defaultModelTtlMs: number;
  preferFakeWorker?: boolean;
  fakeWorkerStartupDelayMs?: number;
  providerSearch?: ProviderSearchService;
  downloadFetch?: typeof fetch;
  shutdownDrainTimeoutMs?: number;
  workerStopTimeoutMs?: number;
  maxResidentMemoryBytes?: number;
  maxWorkersPerModel?: number;
  failureBackoffMs?: number;
  failureBackoffMaxMs?: number;
  failureWindowMs?: number;
  circuitBreakerThreshold?: number;
  circuitBreakerCooldownMs?: number;
}

interface ResolvedModelRecord {
  stored: StoredModelRecord;
  artifact: ModelArtifact;
  profile: ModelProfile;
  capabilities: CapabilitySet;
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
  inflightRequests: number;
  intentionalStop: boolean;
  lastUsedAt: number;
  loadedAt: string;
  profile: ModelProfile;
  runtimeKey: RuntimeEventKey;
  runtimeKeyString: string;
  state: WorkerState;
}

interface RequestQueueEntry {
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface WorkerFailureState {
  breakerOpenUntil?: number | undefined;
  failureTimestamps: number[];
  lastReason?: string | undefined;
  nextRetryAt?: number | undefined;
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

function normalizeCapabilityOverrides(
  overrides: ModelProfile["capabilityOverrides"],
): CapabilityOverrides {
  if (!overrides) {
    return {};
  }

  const normalized: CapabilityOverrides = {};
  for (const key of CAPABILITY_OVERRIDE_KEYS) {
    const value = overrides[key];
    if (typeof value === "boolean") {
      normalized[key] = value;
    }
  }

  return normalized;
}

function applyCapabilityOverrides(
  capabilities: CapabilitySet,
  overrides: ModelProfile["capabilityOverrides"],
): CapabilitySet {
  const normalizedOverrides = normalizeCapabilityOverrides(overrides);

  return {
    chat: normalizedOverrides.chat ?? capabilities.chat,
    embeddings: normalizedOverrides.embeddings ?? capabilities.embeddings,
    tools: normalizedOverrides.tools ?? capabilities.tools,
    streaming: normalizedOverrides.streaming ?? capabilities.streaming,
    vision: normalizedOverrides.vision ?? capabilities.vision,
    audioTranscription: normalizedOverrides.audioTranscription ?? capabilities.audioTranscription,
    audioSpeech: normalizedOverrides.audioSpeech ?? capabilities.audioSpeech,
    rerank: normalizedOverrides.rerank ?? capabilities.rerank,
    promptCache: true,
  };
}

function getEffectiveCapabilities(artifact: ModelArtifact, profile?: ModelProfile): CapabilitySet {
  return applyCapabilityOverrides(artifact.capabilities, profile?.capabilityOverrides);
}

function deriveRuntimeRole(capabilities: CapabilitySet): RuntimeEventRole {
  if (capabilities.rerank) {
    return "rerank";
  }

  if (capabilities.embeddings && !capabilities.chat) {
    return "embeddings";
  }

  return "chat";
}

function getModelRole(artifact: ModelArtifact, profile?: ModelProfile): RuntimeEventRole {
  const capabilities = getEffectiveCapabilities(artifact, profile);
  const normalizedOverrides = normalizeCapabilityOverrides(profile?.capabilityOverrides);
  if (Object.keys(normalizedOverrides).length > 0) {
    return deriveRuntimeRole(capabilities);
  }

  return profile?.role ?? deriveRuntimeRole(capabilities);
}

function hashConfig(profile: ModelProfile): string {
  return createHash("sha1")
    .update(
      JSON.stringify({
        defaultTtlMs: profile.defaultTtlMs,
        parameterOverrides: profile.parameterOverrides,
        promptCacheKey: profile.promptCacheKey ?? null,
        capabilityOverrides: normalizeCapabilityOverrides(profile.capabilityOverrides),
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
    capabilityOverrides: {},
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

function getCapabilityList(artifact: ModelArtifact, profile?: ModelProfile): string[] {
  const effectiveCapabilities = getEffectiveCapabilities(artifact, profile);
  const capabilityList: string[] = [];

  if (effectiveCapabilities.chat) {
    capabilityList.push("chat");
  }
  if (effectiveCapabilities.embeddings) {
    capabilityList.push("embeddings");
  }
  if (effectiveCapabilities.tools) {
    capabilityList.push("tools");
  }
  if (effectiveCapabilities.streaming) {
    capabilityList.push("streaming");
  }
  if (effectiveCapabilities.vision) {
    capabilityList.push("vision");
  }
  if (effectiveCapabilities.audioTranscription) {
    capabilityList.push("audio-transcription");
  }
  if (effectiveCapabilities.audioSpeech) {
    capabilityList.push("audio-speech");
  }
  if (effectiveCapabilities.rerank) {
    capabilityList.push("rerank");
  }
  if (effectiveCapabilities.promptCache) {
    capabilityList.push("prompt-cache");
  }

  return capabilityList;
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

function getEffectiveBatchSize(profile: ModelProfile): number {
  const override = profile.parameterOverrides.batchSize;
  if (typeof override === "number" && Number.isFinite(override) && override > 0) {
    return Math.floor(override);
  }

  return DEFAULT_BATCH_SIZE;
}

function getEffectiveFlashAttentionType(profile: ModelProfile): FlashAttentionType {
  const override = profile.parameterOverrides.flashAttentionType;
  if (override === "enabled" || override === "disabled" || override === "auto") {
    return override;
  }

  return "auto";
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

function hasRuntimeAffectingModelConfigChanges(input: DesktopModelConfigUpdateRequest): boolean {
  return (
    input.defaultTtlMs !== undefined ||
    input.contextLength !== undefined ||
    input.batchSize !== undefined ||
    input.gpuLayers !== undefined ||
    input.parallelSlots !== undefined ||
    input.flashAttentionType !== undefined ||
    input.capabilityOverrides !== undefined
  );
}

function validateBatchSize(batchSize: number | undefined): void {
  if (batchSize === undefined) {
    return;
  }

  if (batchSize % DEFAULT_UBATCH_SIZE !== 0) {
    throw new GatewayRequestError(
      "invalid_batch_size",
      `Batch size must be a multiple of ${DEFAULT_UBATCH_SIZE}.`,
      400,
    );
  }
}

function getMissingArtifactMessage(artifact: ModelArtifact): string {
  return `Local artifact is missing from ${artifact.localPath}.`;
}

function normalizeBaseUrl(healthUrl: string): string {
  return healthUrl.replace(/\/(?:healthz?|)+$/, "").replace(/\/+$/, "");
}

function getChatUsage(response: ChatCompletionsResponse): {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
} {
  return {
    ...(response.usage?.prompt_tokens !== undefined
      ? { promptTokens: response.usage.prompt_tokens }
      : {}),
    ...(response.usage?.completion_tokens !== undefined
      ? { completionTokens: response.usage.completion_tokens }
      : {}),
    ...(response.usage?.total_tokens !== undefined
      ? { totalTokens: response.usage.total_tokens }
      : {}),
  };
}

function requestRequiresVision(messages: ChatCompletionsRequest["messages"]): boolean {
  return messages.some((message) => chatContentHasImages(message.content));
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

  if (chunk.usage?.prompt_tokens !== undefined) {
    accumulator.promptTokens = chunk.usage.prompt_tokens;
  }
  if (chunk.usage?.completion_tokens !== undefined) {
    accumulator.completionTokens = chunk.usage.completion_tokens;
  }
  if (chunk.usage?.total_tokens !== undefined) {
    accumulator.totalTokens = chunk.usage.total_tokens;
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

function createFakeCompletionId(prefix: string, traceId: string): string {
  return `${prefix}-${traceId.replace(/[^A-Za-z0-9]+/g, "").slice(0, 12) || randomUUID().slice(0, 12)}`;
}

function createFakeChatCompletionResponse(
  input: ChatCompletionsRequest,
  traceId: string,
): ChatCompletionsResponse {
  const created = Math.floor(Date.now() / 1000);
  const lastUserMessage = [...input.messages].reverse().find((message) => message.role === "user");
  const userContent = formatChatContentSummary(lastUserMessage?.content ?? "");
  const promptTokens = countChatContentTokens(lastUserMessage?.content ?? "");

  if (input.tools?.length) {
    return {
      id: createFakeCompletionId("chatcmpl", traceId),
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
                id: createFakeCompletionId("call", traceId),
                type: "function",
                function: {
                  name: input.tools[0]?.function.name ?? "tool",
                  arguments: JSON.stringify({ input: userContent }),
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

  const answer = `Fake response from ${input.model}: ${userContent || "Hello from fake llama.cpp"}`;
  const completionTokens = countChatContentTokens(answer);

  return {
    id: createFakeCompletionId("chatcmpl", traceId),
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
}

function createFakeChatStreamResponse(input: ChatCompletionsRequest, traceId: string): Response {
  const completion = createFakeChatCompletionResponse(input, traceId);
  const encoder = new TextEncoder();
  const chunks = [
    {
      id: completion.id,
      object: "chat.completion.chunk",
      created: completion.created,
      model: completion.model,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    },
    {
      id: completion.id,
      object: "chat.completion.chunk",
      created: completion.created,
      model: completion.model,
      choices: completion.choices[0]?.message.tool_calls
        ? [
            {
              index: 0,
              delta: { tool_calls: completion.choices[0].message.tool_calls },
              finish_reason: null,
            },
          ]
        : [
            {
              index: 0,
              delta: { content: completion.choices[0]?.message.content ?? "" },
              finish_reason: null,
            },
          ],
    },
    {
      id: completion.id,
      object: "chat.completion.chunk",
      created: completion.created,
      model: completion.model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: completion.choices[0]?.finish_reason ?? "stop",
        },
      ],
    },
  ];

  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }),
    {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
      },
    },
  );
}

function createFakeEmbeddingsResponse(input: EmbeddingsRequest): EmbeddingsResponse {
  const values = Array.isArray(input.input) ? input.input : [input.input];

  return {
    object: "list",
    model: input.model,
    data: values.map((value, index) => ({
      object: "embedding",
      index,
      embedding: Array.from({ length: 8 }, (_, position) =>
        Number((((String(value).length + 1) * (position + 3)) / 100).toFixed(6)),
      ),
    })),
  };
}

export function normalizeEmbeddingsResponsePayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") {
    return payload;
  }

  const record = payload as Record<string, unknown>;
  const usage = record.usage;
  if (!usage || typeof usage !== "object") {
    return payload;
  }

  const usageRecord = usage as Record<string, unknown>;
  if (typeof usageRecord.completion_tokens === "number") {
    return payload;
  }

  return {
    ...record,
    usage: {
      ...usageRecord,
      completion_tokens: 0,
    },
  };
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
    capabilities: getCapabilityList(stored.artifact, stored.profile),
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
  const batchSize = getEffectiveBatchSize(profile);
  const flashAttentionType = getEffectiveFlashAttentionType(profile);
  const errorMessage =
    artifactStatus === "missing" ? getMissingArtifactMessage(stored.artifact) : snapshot?.lastError;
  const capabilityOverrides = normalizeCapabilityOverrides(profile.capabilityOverrides);

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
    capabilities: getCapabilityList(stored.artifact, profile),
    capabilityOverrides,
    role: getModelRole(stored.artifact, profile),
    tags: stored.artifact.tags,
    localPath: stored.artifact.localPath,
    sourceKind: stored.artifact.source.kind,
    pinned: profile.pinned,
    defaultTtlMs: profile.defaultTtlMs,
    ...(stored.artifact.architecture ? { architecture: stored.artifact.architecture } : {}),
    ...(stored.artifact.quantization ? { quantization: stored.artifact.quantization } : {}),
    ...(contextLength !== undefined ? { contextLength } : {}),
    batchSize,
    flashAttentionType,
    ...(stored.artifact.metadata.parameterCount !== undefined
      ? { parameterCount: stored.artifact.metadata.parameterCount }
      : {}),
    ...(stored.artifact.metadata.tokenizer
      ? { tokenizer: stored.artifact.metadata.tokenizer }
      : {}),
    ...(typeof profile.parameterOverrides.gpuLayers === "number" &&
    Number.isFinite(profile.parameterOverrides.gpuLayers) &&
    profile.parameterOverrides.gpuLayers > 0
      ? { gpuLayers: Math.floor(profile.parameterOverrides.gpuLayers) }
      : {}),
    ...(typeof profile.parameterOverrides.parallelSlots === "number" &&
    Number.isFinite(profile.parameterOverrides.parallelSlots) &&
    profile.parameterOverrides.parallelSlots > 0
      ? { parallelSlots: Math.floor(profile.parameterOverrides.parallelSlots) }
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

function toDownloadRecord(task: ReturnType<LlamaCppDownloadManager["listDownloads"]>[number]) {
  return {
    id: task.id,
    ...(task.modelId ? { modelId: task.modelId } : {}),
    provider: task.provider,
    title: task.providerModelId.split("/").at(-1) ?? task.providerModelId,
    artifactName: task.fileName,
    status: task.status,
    progress: task.progress,
    downloadedBytes: task.downloadedBytes,
    ...(task.totalBytes !== undefined ? { totalBytes: task.totalBytes } : {}),
    destinationPath: task.destinationPath,
    updatedAt: task.updatedAt,
    ...(task.errorMessage ? { errorMessage: task.errorMessage } : {}),
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
      return route;
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
}

export class RepositoryGatewayRuntime implements GatewayRuntime {
  readonly #adapter;
  readonly #chatRepository: ChatRepository;
  readonly #database: DatabaseSync;
  readonly #defaultModelTtlMs: number;
  readonly #downloadsRepository: DownloadTasksRepository;
  readonly #downloadManager: LlamaCppDownloadManager;
  readonly #enginesRepository: EngineVersionsRepository;
  readonly #modelManager: LlamaCppModelManager;
  readonly #modelsRepository: ModelsRepository;
  readonly #startedAt = Date.now();
  readonly #subscribers = new Set<(event: GatewayEvent) => void>();
  readonly #supportRoot: string;
  readonly #telemetryIntervalMs: number;
  readonly #shutdownDrainTimeoutMs: number;
  readonly #workerStopTimeoutMs: number;
  readonly #maxResidentMemoryBytes: number;
  readonly #maxWorkersPerModel: number;
  readonly #failureBackoffMs: number;
  readonly #failureBackoffMaxMs: number;
  readonly #failureWindowMs: number;
  readonly #circuitBreakerThreshold: number;
  readonly #circuitBreakerCooldownMs: number;

  #started = false;
  #stopping = false;
  #stopPromise: Promise<void> | undefined;
  #telemetryTimer: NodeJS.Timeout | undefined;
  #loadPromises = new Map<string, Set<Promise<ManagedWorker>>>();
  #pendingLoadReservations = new Map<string, number>();
  #requestQueues = new Map<string, RequestQueueEntry[]>();
  #activeRequestCounts = new Map<string, number>();
  #modelSnapshots = new Map<string, RuntimeSnapshot>();
  #workerFailures = new Map<string, WorkerFailureState>();
  #workers = new Map<string, ManagedWorker[]>();

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
    this.#shutdownDrainTimeoutMs =
      options.shutdownDrainTimeoutMs ?? DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS;
    this.#workerStopTimeoutMs = options.workerStopTimeoutMs ?? DEFAULT_WORKER_STOP_TIMEOUT_MS;
    this.#maxResidentMemoryBytes =
      options.maxResidentMemoryBytes ?? DEFAULT_MAX_RESIDENT_MEMORY_BYTES;
    this.#maxWorkersPerModel = options.maxWorkersPerModel ?? DEFAULT_MAX_WORKERS_PER_MODEL;
    this.#failureBackoffMs = options.failureBackoffMs ?? DEFAULT_FAILURE_BACKOFF_MS;
    this.#failureBackoffMaxMs = options.failureBackoffMaxMs ?? DEFAULT_FAILURE_BACKOFF_MAX_MS;
    this.#failureWindowMs = options.failureWindowMs ?? DEFAULT_FAILURE_WINDOW_MS;
    this.#circuitBreakerThreshold =
      options.circuitBreakerThreshold ?? DEFAULT_CIRCUIT_BREAKER_THRESHOLD;
    this.#circuitBreakerCooldownMs =
      options.circuitBreakerCooldownMs ?? DEFAULT_CIRCUIT_BREAKER_COOLDOWN_MS;
    this.#modelsRepository = new ModelsRepository(database);
    this.#enginesRepository = new EngineVersionsRepository(database);
    this.#downloadsRepository = new DownloadTasksRepository(database);
    const promptCachesRepository = new PromptCachesRepository(database);
    this.#chatRepository = new ChatRepository(database);
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
      localModelsDir: options.localModelsDir,
      adapter: this.#adapter,
      modelsRepository: this.#modelsRepository,
      engineVersionsRepository: this.#enginesRepository,
      promptCachesRepository,
    });
    this.#downloadManager = new LlamaCppDownloadManager({
      supportRoot: this.#supportRoot,
      downloadsRepository: this.#downloadsRepository,
      modelManager: this.#modelManager,
      providerSearch: options.providerSearch ?? createDefaultProviderSearchService(),
      ...(options.downloadFetch ? { fetch: options.downloadFetch } : {}),
      emitEvent: (event: GatewayEvent) => {
        this.publish(event);
      },
    });
  }

  async start(): Promise<void> {
    if (this.#started) {
      return;
    }

    this.#started = true;
    this.#stopping = false;
    this.publishLog(
      "info",
      "Repository-backed gateway runtime started.",
      undefined,
      undefined,
      "system",
    );
    const discoveredModels = await this.#modelManager.scanLocalModels();
    if (discoveredModels.length > 0) {
      this.publishLog(
        "info",
        `Auto-discovered ${discoveredModels.length} local model(s) from the configured scan path.`,
        undefined,
        undefined,
        "system",
      );
    }
    this.replayModelSnapshots();

    this.#telemetryTimer = setInterval(() => {
      this.publish(this.createMetricsEvent());
    }, this.#telemetryIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.#stopPromise) {
      return this.#stopPromise;
    }

    this.#stopPromise = this.performStop();
    return this.#stopPromise;
  }

  private async performStop(): Promise<void> {
    this.#stopping = true;
    if (this.#telemetryTimer) {
      clearInterval(this.#telemetryTimer);
      this.#telemetryTimer = undefined;
    }

    this.publishLog(
      "info",
      "Repository-backed gateway runtime is draining active work before shutdown.",
      undefined,
      undefined,
      "system",
    );

    const drained = await this.waitForDrain(this.#shutdownDrainTimeoutMs);
    if (!drained) {
      this.publishLog(
        "warn",
        "Gateway shutdown drain timed out; forcing worker cleanup.",
        undefined,
        undefined,
        "system",
      );
    }

    this.rejectQueuedRequests(
      new GatewayRequestError(
        "gateway_stopping",
        "The gateway is shutting down and is not accepting new work.",
        503,
      ),
    );

    const activeWorkers = this.getAllWorkers();
    await Promise.allSettled(
      activeWorkers.map((worker) =>
        this.stopWorker(
          worker,
          normalizeTraceId(undefined),
          drained
            ? "Gateway shutdown requested."
            : "Gateway shutdown forced cleanup after drain timeout.",
        ),
      ),
    );
    await Promise.allSettled(this.getAllLoadPromises());
    this.#workers.clear();
    this.#loadPromises.clear();
    this.#pendingLoadReservations.clear();

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

  listModels(): OpenAiModelCard[] {
    return this.#modelsRepository.list().map((stored) => {
      const profile = this.getProfile(stored);

      return {
        id: profile.displayName,
        name: profile.displayName,
        model_id: stored.artifact.id,
        object: "model",
        created: getCreatedEpochSeconds(stored.artifact),
        owned_by: "localhub",
      };
    });
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

  listDownloads(): DesktopDownloadList {
    return desktopDownloadListSchema.parse({
      object: "list",
      data: this.#downloadManager
        .listDownloads()
        .map((task: Parameters<typeof toDownloadRecord>[0]) => toDownloadRecord(task)),
    });
  }

  listChatSessions(): DesktopChatSessionList {
    return desktopChatSessionListSchema.parse({
      object: "list",
      data: this.#chatRepository.listSessions(),
    });
  }

  listChatMessages(sessionId: string): DesktopChatMessageList {
    return desktopChatMessageListSchema.parse({
      object: "list",
      data: this.#chatRepository.listMessages(sessionId),
    });
  }

  upsertChatSession(input: DesktopChatSessionUpsertRequest): ChatSession {
    const now = nowIso();
    const existing = input.id
      ? this.#chatRepository.listSessions().find((session) => session.id === input.id)
      : undefined;
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

    this.#chatRepository.upsertSession(session);
    return session;
  }

  deleteChatSession(sessionId: string): boolean {
    return this.#chatRepository.deleteSession(sessionId);
  }

  async runChat(input: DesktopChatRunRequest, traceId?: string): Promise<DesktopChatRunResponse> {
    const now = nowIso();
    const session = this.upsertChatSession({
      ...(input.sessionId ? { id: input.sessionId } : {}),
      modelId: input.model,
      ...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt } : {}),
    });
    const chatSettings = getChatSettings(session.metadata);
    const maxTokens = input.maxTokens ?? chatSettings.maxOutputTokens;
    const userMessage: ChatMessage = {
      id: `message_${randomUUID().slice(0, 12)}`,
      sessionId: session.id,
      role: "user",
      content: input.message,
      toolCalls: [],
      tokensCount: countChatContentTokens(input.message),
      metadata: {},
      createdAt: now,
    };
    this.#chatRepository.appendMessage(userMessage);

    const completion = await this.createChatCompletion(
      {
        model: input.model,
        stream: false,
        ...(chatSettings.temperature !== undefined ? { temperature: chatSettings.temperature } : {}),
        ...(chatSettings.topP !== undefined ? { top_p: chatSettings.topP } : {}),
        ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
        messages: buildChatCompletionMessages(
          this.#chatRepository,
          session.id,
          session.systemPrompt,
          chatSettings.maxMessagesInContext,
        ),
      },
      {
        traceId: normalizeTraceId(traceId),
      },
    );

    const assistantContent = completion.choices[0]?.message.content;
    const reasoningContent = getReasoningContent(completion.choices[0]?.message);
    const finishReason = completion.choices[0]?.finish_reason;
    const assistantMessage: ChatMessage = {
      id: `message_${randomUUID().slice(0, 12)}`,
      sessionId: session.id,
      role: "assistant",
      content: normalizeAssistantContent(assistantContent),
      toolCalls: completion.choices[0]?.message.tool_calls ?? [],
      tokensCount: completion.usage?.completion_tokens,
      metadata: buildAssistantMetadata({
        reasoningContent,
        finishReason,
      }),
      createdAt: nowIso(),
    };
    this.#chatRepository.appendMessage(assistantMessage);

    const updatedSession = this.upsertChatSession({
      id: session.id,
      modelId: input.model,
      ...(session.systemPrompt !== undefined ? { systemPrompt: session.systemPrompt } : {}),
      ...(session.title
        ? { title: session.title }
        : { title: createChatSessionTitle(input.message) }),
    });

    return desktopChatRunResponseSchema.parse({
      session: updatedSession,
      userMessage,
      assistantMessage,
      response: completion,
    });
  }

  async runChatStream(
    input: DesktopChatRunRequest,
    traceId?: string,
  ): Promise<DesktopChatRunStreamResult> {
    const now = nowIso();
    const normalizedTraceId = normalizeTraceId(traceId);
    const session = this.upsertChatSession({
      ...(input.sessionId ? { id: input.sessionId } : {}),
      modelId: input.model,
      ...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt } : {}),
    });
    const chatSettings = getChatSettings(session.metadata);
    const maxTokens = input.maxTokens ?? chatSettings.maxOutputTokens;
    const userMessage: ChatMessage = {
      id: `message_${randomUUID().slice(0, 12)}`,
      sessionId: session.id,
      role: "user",
      content: input.message,
      toolCalls: [],
      tokensCount: countChatContentTokens(input.message),
      metadata: {},
      createdAt: now,
    };
    this.#chatRepository.appendMessage(userMessage);

    const assistantMessageId = `message_${randomUUID().slice(0, 12)}`;
    const accumulator = createStreamedAssistantAccumulator();
    const completionStream = await this.createChatCompletionStream(
      {
        model: input.model,
        stream: true,
        ...(chatSettings.temperature !== undefined ? { temperature: chatSettings.temperature } : {}),
        ...(chatSettings.topP !== undefined ? { top_p: chatSettings.topP } : {}),
        ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
        messages: buildChatCompletionMessages(
          this.#chatRepository,
          session.id,
          session.systemPrompt,
          chatSettings.maxMessagesInContext,
        ),
      },
      {
        traceId: normalizedTraceId,
      },
    );

    let finalized = false;
    const persistAssistantMessage = (): void => {
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
        createdAt: nowIso(),
      };
      this.#chatRepository.appendMessage(assistantMessage);
      this.upsertChatSession({
        id: session.id,
        modelId: input.model,
        ...(session.systemPrompt !== undefined ? { systemPrompt: session.systemPrompt } : {}),
        ...(session.title
          ? { title: session.title }
          : { title: createChatSessionTitle(input.message) }),
      });
    };

    const reader = completionStream.stream.getReader();
    const decoder = new TextDecoder();

    return {
      contentType: completionStream.contentType,
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

  listRecentApiLogs(limit = 30): DesktopApiLogList {
    return desktopApiLogListSchema.parse({
      object: "list",
      data: this.#chatRepository.listRecentApiLogs(limit),
    });
  }

  async searchCatalog(query: string): Promise<DesktopProviderSearchResult> {
    const result = await this.#downloadManager.search({
      text: query,
      formats: ["gguf"],
      limit: 20,
    });

    return {
      object: "list",
      data: result.items.map((item) => toDesktopProviderSearchItem(item)),
      warnings: result.warnings,
    };
  }

  async getCatalogModel(
    provider: ProviderId,
    providerModelId: string,
  ): Promise<DesktopProviderCatalogDetailResponse> {
    const item = await this.#downloadManager.getCatalogModel(provider, providerModelId);

    return {
      object: "model",
      data: toDesktopProviderCatalogDetail(item),
      warnings: item.artifacts.length === 0 ? ["No GGUF variants found for this repository."] : [],
    };
  }

  async createDownload(
    input: DesktopDownloadCreateRequest,
    _traceId?: string,
  ): Promise<DesktopDownloadActionResponse> {
    this.assertAcceptingNewWork();
    const metadata =
      input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)
        ? input.metadata
        : {};
    const task = await this.#downloadManager.startDownload({
      provider: input.provider,
      providerModelId: input.providerModelId,
      artifactId: input.artifactId,
      displayName: input.title,
      ...(typeof metadata.autoRegister === "boolean"
        ? { autoRegister: metadata.autoRegister }
        : {}),
      ...(typeof metadata.bundleId === "string" && metadata.bundleId.length > 0
        ? { bundleId: metadata.bundleId }
        : {}),
      ...(typeof metadata.bundlePrimaryArtifactId === "string" &&
      metadata.bundlePrimaryArtifactId.length > 0
        ? { bundlePrimaryArtifactId: metadata.bundlePrimaryArtifactId }
        : {}),
    });

    return desktopDownloadActionResponseSchema.parse({
      accepted: true,
      task: toDownloadRecord(task),
    });
  }

  async pauseDownload(id: string, _traceId?: string): Promise<DesktopDownloadActionResponse> {
    const task = await this.#downloadManager.pauseDownload(id);
    return desktopDownloadActionResponseSchema.parse({
      accepted: true,
      task: toDownloadRecord(task),
    });
  }

  async resumeDownload(id: string, _traceId?: string): Promise<DesktopDownloadActionResponse> {
    const task = await this.#downloadManager.resumeDownload(id);
    return desktopDownloadActionResponseSchema.parse({
      accepted: true,
      task: toDownloadRecord(task),
    });
  }

  listEngines(): EngineRecord[] {
    return this.#enginesRepository.list().map((record) => toEngineRecord(record));
  }

  async installEngineBinary(
    input: DesktopEngineInstallRequest,
    traceId?: string,
  ): Promise<DesktopEngineInstallResponse> {
    this.assertAcceptingNewWork();
    const normalizedTraceId = normalizeTraceId(traceId);

    const installResult =
      input.action === "download-latest-metal"
        ? await this.#modelManager.downloadPackagedMetalBinary({
            ...(input.versionTag ? { versionTag: input.versionTag } : {}),
          })
        : input.action === "import-local-binary"
          ? await this.#modelManager.importLocalEngineBinary({
              sourcePath: input.filePath,
              ...(input.versionTag ? { versionTag: input.versionTag } : {}),
            })
          : await this.#modelManager.activateEngineVersion(input.versionTag);

    const stored = this.#enginesRepository
      .list()
      .find(
        (record) =>
          record.engineType === DEFAULT_ENGINE_TYPE &&
          record.versionTag === installResult.versionTag,
      );

    if (!stored) {
      throw new Error(
        `Installed llama.cpp version ${installResult.versionTag} could not be recorded.`,
      );
    }

    this.publishLog("info", installResult.notes.join(" "), normalizedTraceId, undefined, "desktop");

    return desktopEngineInstallResponseSchema.parse({
      accepted: true,
      engine: toEngineRecord(stored),
      notes: installResult.notes,
    });
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
    this.assertAcceptingNewWork();
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

  updateModelConfig(
    modelId: string,
    input: DesktopModelConfigUpdateRequest,
    _traceId?: string,
  ): DesktopModelConfigUpdateResponse {
    const resolved = this.resolveModelRecord(modelId);
    validateBatchSize(input.batchSize);

    if (
      hasRuntimeAffectingModelConfigChanges(input) &&
      this.getWorkerPool(resolved.runtimeKeyString).length > 0
    ) {
      throw new GatewayRequestError(
        "model_config_requires_cold_state",
        "Evict the model from memory before changing advanced runtime settings.",
        409,
      );
    }

    const nextProfile: ModelProfile = {
      ...resolved.profile,
      ...(input.displayName ? { displayName: input.displayName } : {}),
      ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
      ...(input.defaultTtlMs !== undefined ? { defaultTtlMs: input.defaultTtlMs } : {}),
      parameterOverrides: {
        ...resolved.profile.parameterOverrides,
        ...(input.contextLength !== undefined ? { contextLength: input.contextLength } : {}),
        ...(input.batchSize !== undefined ? { batchSize: input.batchSize } : {}),
        ...(input.gpuLayers !== undefined ? { gpuLayers: input.gpuLayers } : {}),
        ...(input.parallelSlots !== undefined ? { parallelSlots: input.parallelSlots } : {}),
        ...(input.flashAttentionType !== undefined
          ? { flashAttentionType: input.flashAttentionType }
          : {}),
      },
      ...(input.capabilityOverrides !== undefined
        ? { capabilityOverrides: normalizeCapabilityOverrides(input.capabilityOverrides) }
        : {}),
      updatedAt: nowIso(),
    };

    const nextCapabilities = getEffectiveCapabilities(resolved.artifact, nextProfile);
    nextProfile.role = deriveRuntimeRole(nextCapabilities);

    this.#modelsRepository.save(resolved.artifact, nextProfile);

    const refreshedStored = this.#modelsRepository.findById(modelId);
    if (!refreshedStored) {
      throw new Error(`Updated model ${modelId} could not be reloaded.`);
    }

    const activeEngine = this.#enginesRepository
      .list()
      .find((record) => record.engineType === nextProfile.engineType && record.isActive);

    return desktopModelConfigUpdateResponseSchema.parse({
      model: toDesktopModelRecord(
        refreshedStored,
        nextProfile,
        this.#modelSnapshots.get(modelId),
        activeEngine,
      ),
    });
  }

  async preloadModel(modelId: string, traceId?: string): Promise<PreloadModelResult> {
    this.assertAcceptingNewWork();
    const resolved = this.resolveModelRecord(modelId);
    const existingWorkers = this.getWorkerPool(resolved.runtimeKeyString);
    const warmWorker = existingWorkers.find(
      (worker) => worker.state === "Ready" || worker.state === "Busy",
    );

    if (warmWorker) {
      this.refreshTtl(warmWorker);
      return {
        model: this.getRuntimeModelById(modelId),
        alreadyWarm: true,
      };
    }

    const existingLoad = this.getPendingLoadPromises(resolved.runtimeKeyString);
    if (existingLoad.length > 0) {
      await Promise.any(existingLoad);

      const refreshedWorker = this.getWorkerPool(resolved.runtimeKeyString).find(
        (worker) => worker.state === "Ready" || worker.state === "Busy",
      );
      if (refreshedWorker) {
        this.refreshTtl(refreshedWorker);
        return {
          model: this.getRuntimeModelById(modelId),
          alreadyWarm: false,
        };
      }
    }

    const loadPromise = this.loadWorker(resolved, normalizeTraceId(traceId));
    await loadPromise;
    return {
      model: this.getRuntimeModelById(modelId),
      alreadyWarm: false,
    };
  }

  async evictModel(modelId: string, traceId?: string): Promise<EvictModelResult> {
    const resolved = this.resolveModelRecord(modelId);
    const pendingLoad = this.getPendingLoadPromises(resolved.runtimeKeyString);

    if (pendingLoad.length > 0) {
      await Promise.allSettled(pendingLoad);
    }

    const workers = [...this.getWorkerPool(resolved.runtimeKeyString)];
    if (workers.length === 0) {
      return {
        model: this.getRuntimeModelById(modelId),
        wasLoaded: false,
      };
    }

    await Promise.allSettled(
      workers.map((worker) =>
        this.stopWorker(worker, normalizeTraceId(traceId), "Model was evicted from memory."),
      ),
    );

    return {
      model: this.getRuntimeModelById(modelId),
      wasLoaded: true,
    };
  }

  async createChatCompletion(
    input: ChatCompletionsRequest,
    context: GatewayExecutionContext,
  ): Promise<ChatCompletionsResponse> {
    const worker = await this.acquireWorkerForRequest(
      input.model,
      "chat",
      context.traceId,
      requestRequiresVision(input.messages),
    );
    const startedAt = Date.now();

    try {
      const response = await this.fetchWorkerResponse(worker, "/v1/chat/completions", input);
      const payload = chatCompletionsResponseSchema.parse(
        this.#adapter.normalizeResponse(await response.json()),
      );
      const usage = getChatUsage(payload);

      this.insertApiLog({
        traceId: context.traceId,
        modelId: input.model,
        endpoint: "/v1/chat/completions",
        requestIp: context.remoteAddress,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalDurationMs: Date.now() - startedAt,
        tokensPerSecond:
          usage.completionTokens && Date.now() > startedAt
            ? Number((usage.completionTokens / ((Date.now() - startedAt) / 1000)).toFixed(2))
            : undefined,
        statusCode: response.status,
        createdAt: nowIso(),
      });

      return payload;
    } catch (error) {
      this.insertApiLog({
        traceId: context.traceId,
        modelId: input.model,
        endpoint: "/v1/chat/completions",
        requestIp: context.remoteAddress,
        totalDurationMs: Date.now() - startedAt,
        statusCode: error instanceof GatewayRequestError ? error.statusCode : 500,
        errorMessage: error instanceof Error ? error.message : "Chat completion failed.",
        createdAt: nowIso(),
      });
      throw error;
    } finally {
      this.releaseWorkerAfterRequest(worker, context.traceId, "Chat completion finished.");
    }
  }

  async createChatCompletionStream(
    input: ChatCompletionsRequest,
    context: GatewayExecutionContext,
  ): Promise<ChatCompletionsStreamResult> {
    const worker = await this.acquireWorkerForRequest(
      input.model,
      "chat",
      context.traceId,
      requestRequiresVision(input.messages),
    );
    const startedAt = Date.now();
    let firstChunkAt: number | undefined;
    let settled = false;
    const accumulator = createStreamedAssistantAccumulator();

    try {
      const response = await this.fetchWorkerResponse(worker, "/v1/chat/completions", {
        ...input,
        stream: true,
      });

      if (!response.body) {
        throw new GatewayRequestError(
          "stream_unavailable",
          "The model worker did not provide a streaming response body.",
          502,
        );
      }

      const reader = response.body.getReader();
      const encoder = new TextEncoder();
      const decoder = new TextDecoder();
      let sseBuffer = "";
      const finalize = (reason: string) => {
        if (settled) {
          return;
        }

        settled = true;
        this.releaseWorkerAfterRequest(worker, context.traceId, reason);
      };
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          const heartbeat = setInterval(() => {
            controller.enqueue(encoder.encode(": keep-alive\n\n"));
          }, DEFAULT_STREAM_HEARTBEAT_MS);
          heartbeat.unref?.();

          void (async () => {
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) {
                  break;
                }

                if (firstChunkAt === undefined) {
                  firstChunkAt = Date.now();
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

                  const parsed = chatCompletionsChunkSchema.safeParse(
                    this.#adapter.normalizeResponse(parsedJson),
                  );
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

                  let parsedJson: unknown;
                  try {
                    parsedJson = JSON.parse(data);
                  } catch {
                    return;
                  }

                  const parsed = chatCompletionsChunkSchema.safeParse(
                    this.#adapter.normalizeResponse(parsedJson),
                  );
                  if (parsed.success) {
                    applyChunkToAccumulator(accumulator, parsed.data);
                  }
                });
              }

              controller.close();
              const completionParts = [accumulator.reasoning, accumulator.content].filter(
                (part) => part.trim().length > 0,
              );
              const completionTokens =
                completionParts.length > 0 ? estimateTextTokens(completionParts) : undefined;
              const totalDurationMs = Date.now() - startedAt;
              const safeDurationMs = Math.max(totalDurationMs, 1);
              this.insertApiLog({
                traceId: context.traceId,
                modelId: input.model,
                endpoint: "/v1/chat/completions",
                requestIp: context.remoteAddress,
                ttftMs: firstChunkAt ? firstChunkAt - startedAt : undefined,
                totalDurationMs,
                ...(completionTokens !== undefined ? { completionTokens } : {}),
                ...(completionTokens !== undefined
                  ? {
                      tokensPerSecond: Number(
                        ((completionTokens * 1000) / safeDurationMs).toFixed(2),
                      ),
                    }
                  : {}),
                statusCode: response.status,
                createdAt: nowIso(),
              });
            } catch (error) {
              controller.error(error);
              this.insertApiLog({
                traceId: context.traceId,
                modelId: input.model,
                endpoint: "/v1/chat/completions",
                requestIp: context.remoteAddress,
                ttftMs: firstChunkAt ? firstChunkAt - startedAt : undefined,
                totalDurationMs: Date.now() - startedAt,
                statusCode: error instanceof GatewayRequestError ? error.statusCode : 500,
                errorMessage: error instanceof Error ? error.message : "Streaming chat failed.",
                createdAt: nowIso(),
              });
            } finally {
              clearInterval(heartbeat);
              reader.releaseLock();
              finalize("Streaming chat finished.");
            }
          })();
        },
        cancel: async () => {
          await reader.cancel().catch(() => undefined);
          this.insertApiLog({
            traceId: context.traceId,
            modelId: input.model,
            endpoint: "/v1/chat/completions",
            requestIp: context.remoteAddress,
            ttftMs: firstChunkAt ? firstChunkAt - startedAt : undefined,
            totalDurationMs: Date.now() - startedAt,
            statusCode: 499,
            errorMessage: "Client cancelled the streaming response.",
            createdAt: nowIso(),
          });
          finalize("Streaming chat cancelled.");
        },
      });

      return {
        contentType: response.headers.get("content-type") ?? "text/event-stream; charset=utf-8",
        stream,
      };
    } catch (error) {
      this.insertApiLog({
        traceId: context.traceId,
        modelId: input.model,
        endpoint: "/v1/chat/completions",
        requestIp: context.remoteAddress,
        totalDurationMs: Date.now() - startedAt,
        statusCode: error instanceof GatewayRequestError ? error.statusCode : 500,
        errorMessage: error instanceof Error ? error.message : "Streaming chat failed.",
        createdAt: nowIso(),
      });
      if (!settled) {
        this.releaseWorkerAfterRequest(worker, context.traceId, "Streaming chat failed.");
      }
      throw error;
    }
  }

  async createEmbeddings(
    input: EmbeddingsRequest,
    context: GatewayExecutionContext,
  ): Promise<EmbeddingsResponse> {
    const worker = await this.acquireWorkerForRequest(input.model, "embeddings", context.traceId);
    const startedAt = Date.now();

    try {
      const response = await this.fetchWorkerResponse(worker, "/v1/embeddings", input);
      const payload = embeddingsResponseSchema.parse(
        normalizeEmbeddingsResponsePayload(this.#adapter.normalizeResponse(await response.json())),
      );

      this.insertApiLog({
        traceId: context.traceId,
        modelId: input.model,
        endpoint: "/v1/embeddings",
        requestIp: context.remoteAddress,
        promptTokens: estimateTextTokens(input.input),
        totalDurationMs: Date.now() - startedAt,
        statusCode: response.status,
        createdAt: nowIso(),
      });

      return payload;
    } catch (error) {
      this.insertApiLog({
        traceId: context.traceId,
        modelId: input.model,
        endpoint: "/v1/embeddings",
        requestIp: context.remoteAddress,
        totalDurationMs: Date.now() - startedAt,
        statusCode: error instanceof GatewayRequestError ? error.statusCode : 500,
        errorMessage: error instanceof Error ? error.message : "Embeddings request failed.",
        createdAt: nowIso(),
      });
      throw error;
    } finally {
      this.releaseWorkerAfterRequest(worker, context.traceId, "Embeddings request finished.");
    }
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

  private assertAcceptingNewWork(): void {
    if (this.#stopping) {
      throw new GatewayRequestError(
        "gateway_stopping",
        "The gateway is shutting down and is not accepting new work.",
        503,
      );
    }
  }

  private getWorkerPool(runtimeKeyString: string): ManagedWorker[] {
    return this.#workers.get(runtimeKeyString) ?? [];
  }

  private getAllWorkers(): ManagedWorker[] {
    return Array.from(this.#workers.values()).flat();
  }

  private getPendingLoadPromises(runtimeKeyString: string): Promise<ManagedWorker>[] {
    return Array.from(this.#loadPromises.get(runtimeKeyString) ?? []);
  }

  private getAllLoadPromises(): Promise<ManagedWorker>[] {
    return Array.from(this.#loadPromises.values()).flatMap((pendingLoads) =>
      Array.from(pendingLoads),
    );
  }

  private getWorkerPoolSize(runtimeKeyString: string): number {
    return this.getWorkerPool(runtimeKeyString).length;
  }

  private getPendingLoadReservationCount(runtimeKeyString: string): number {
    return this.#pendingLoadReservations.get(runtimeKeyString) ?? 0;
  }

  private getActiveRequestCount(runtimeKeyString: string): number {
    return this.#activeRequestCounts.get(runtimeKeyString) ?? 0;
  }

  private getQueuedRequestEntries(runtimeKeyString: string): RequestQueueEntry[] {
    return this.#requestQueues.get(runtimeKeyString) ?? [];
  }

  private getQueuedRequestCount(runtimeKeyString: string): number {
    return this.getQueuedRequestEntries(runtimeKeyString).length;
  }

  private getTotalQueuedRequestCount(): number {
    return Array.from(this.#requestQueues.values()).reduce(
      (total, entries) => total + entries.length,
      0,
    );
  }

  private incrementPendingLoadReservation(runtimeKeyString: string): void {
    this.#pendingLoadReservations.set(
      runtimeKeyString,
      this.getPendingLoadReservationCount(runtimeKeyString) + 1,
    );
  }

  private decrementPendingLoadReservation(runtimeKeyString: string): void {
    const nextCount = Math.max(0, this.getPendingLoadReservationCount(runtimeKeyString) - 1);
    if (nextCount === 0) {
      this.#pendingLoadReservations.delete(runtimeKeyString);
      return;
    }

    this.#pendingLoadReservations.set(runtimeKeyString, nextCount);
  }

  private getWorkerSlotCount(runtimeKeyString: string): number {
    return (
      this.getWorkerPoolSize(runtimeKeyString) +
      this.getPendingLoadReservationCount(runtimeKeyString)
    );
  }

  private async acquireRequestTurn(runtimeKeyString: string, traceId: string): Promise<void> {
    if (this.#stopping) {
      throw new GatewayRequestError(
        "gateway_stopping",
        "The gateway is shutting down and is not accepting new work.",
        503,
      );
    }

    const currentQueue = this.getQueuedRequestEntries(runtimeKeyString);
    if (
      currentQueue.length === 0 &&
      this.getActiveRequestCount(runtimeKeyString) < this.#maxWorkersPerModel
    ) {
      this.#activeRequestCounts.set(
        runtimeKeyString,
        this.getActiveRequestCount(runtimeKeyString) + 1,
      );
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const queue = this.getQueuedRequestEntries(runtimeKeyString);
      queue.push({ resolve, reject });
      this.#requestQueues.set(runtimeKeyString, queue);
      this.publishLog(
        "info",
        `Queued request for model ${runtimeKeyString}.`,
        traceId,
        undefined,
        "gateway",
      );
    });
  }

  private releaseRequestTurn(runtimeKeyString: string): void {
    const queue = this.getQueuedRequestEntries(runtimeKeyString);
    if (this.#stopping && queue.length > 0) {
      for (const entry of queue) {
        entry.reject(
          new GatewayRequestError(
            "gateway_stopping",
            "The gateway is shutting down and is not accepting new work.",
            503,
          ),
        );
      }

      this.#requestQueues.delete(runtimeKeyString);
      const nextCount = Math.max(0, this.getActiveRequestCount(runtimeKeyString) - 1);
      if (nextCount === 0) {
        this.#activeRequestCounts.delete(runtimeKeyString);
      } else {
        this.#activeRequestCounts.set(runtimeKeyString, nextCount);
      }
      return;
    }

    if (queue.length > 0) {
      const next = queue.shift();
      if (queue.length === 0) {
        this.#requestQueues.delete(runtimeKeyString);
      } else {
        this.#requestQueues.set(runtimeKeyString, queue);
      }

      this.#activeRequestCounts.set(
        runtimeKeyString,
        Math.max(1, this.getActiveRequestCount(runtimeKeyString)),
      );
      if (next) {
        next.resolve();
      }

      return;
    }

    const nextCount = Math.max(0, this.getActiveRequestCount(runtimeKeyString) - 1);
    if (nextCount === 0) {
      this.#activeRequestCounts.delete(runtimeKeyString);
      return;
    }

    this.#activeRequestCounts.set(runtimeKeyString, nextCount);
  }

  private rejectQueuedRequests(error: unknown): void {
    for (const [runtimeKeyString, queue] of this.#requestQueues.entries()) {
      for (const entry of queue) {
        entry.reject(error);
      }
    }
    this.#requestQueues.clear();
  }

  private addWorkerToPool(worker: ManagedWorker): void {
    const pool = this.#workers.get(worker.runtimeKeyString);
    if (pool) {
      pool.push(worker);
      return;
    }

    this.#workers.set(worker.runtimeKeyString, [worker]);
  }

  private removeWorkerFromPool(worker: ManagedWorker): boolean {
    const pool = this.#workers.get(worker.runtimeKeyString);
    if (!pool) {
      return false;
    }

    const index = pool.indexOf(worker);
    if (index < 0) {
      return false;
    }

    pool.splice(index, 1);
    if (pool.length === 0) {
      this.#workers.delete(worker.runtimeKeyString);
    }

    return true;
  }

  private getRepresentativeWorker(workers: ManagedWorker[]): ManagedWorker | undefined {
    return (
      workers.find((worker) => worker.state === "Busy") ??
      workers.find((worker) => worker.state === "Ready") ??
      workers.find((worker) => worker.state === "Loading") ??
      workers.find((worker) => worker.state === "Unloading") ??
      workers.find((worker) => worker.state === "Crashed") ??
      workers.find((worker) => worker.state === "CoolingDown") ??
      workers[0]
    );
  }

  private refreshModelSnapshot(
    artifact: ModelArtifact,
    runtimeKey: RuntimeEventKey,
    runtimeKeyString: string,
    lastError?: string,
  ): void {
    const workers = this.getWorkerPool(runtimeKeyString);
    const representative = this.getRepresentativeWorker(workers);

    if (!representative) {
      this.#modelSnapshots.set(artifact.id, {
        loaded: false,
        runtimeKey,
        state: "Idle",
        updatedAt: nowIso(),
        ...(lastError ? { lastError } : {}),
      });
      return;
    }

    this.#modelSnapshots.set(artifact.id, {
      loaded: workers.some((worker) => isLoadedState(worker.state)),
      runtimeKey: representative.runtimeKey,
      state: representative.state,
      updatedAt: nowIso(),
      ...(lastError ? { lastError } : {}),
    });
  }

  private async waitForDrain(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (
        this.getAllLoadPromises().length === 0 &&
        this.getAllWorkers().every((worker) => worker.inflightRequests === 0)
      ) {
        return true;
      }

      await new Promise((resolve) => {
        setTimeout(resolve, 25);
      });
    }

    return (
      this.getAllLoadPromises().length === 0 &&
      this.getAllWorkers().every((worker) => worker.inflightRequests === 0)
    );
  }

  private getProfile(stored: StoredModelRecord): ModelProfile {
    return stored.profile ?? createDefaultProfile(stored.artifact, this.#defaultModelTtlMs);
  }

  private findStoredModelRecord(modelId: string): StoredModelRecord | undefined {
    const exactMatch = this.#modelsRepository.findById(modelId);
    if (exactMatch) {
      return exactMatch;
    }

    return this.#modelsRepository
      .list()
      .find((stored) => this.getProfile(stored).displayName === modelId);
  }

  private getRuntimeModelById(modelId: string): RuntimeModelRecord {
    const stored = this.findStoredModelRecord(modelId);
    if (!stored) {
      throw new Error(`Unknown model: ${modelId}`);
    }

    return toRuntimeModelRecord(stored, this.#modelSnapshots.get(stored.artifact.id));
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
    const stored = this.findStoredModelRecord(modelId);
    if (!stored) {
      throw new Error(`Unknown model: ${modelId}`);
    }

    const profile = this.getProfile(stored);
    const capabilities = getEffectiveCapabilities(stored.artifact, profile);
    const runtimeKey = buildRuntimeKey(stored.artifact, profile);

    return {
      stored,
      artifact: stored.artifact,
      profile,
      capabilities,
      runtimeKey,
      runtimeKeyString: runtimeKeyToString(runtimeKey),
    };
  }

  private ensureModelCapability(
    resolved: ResolvedModelRecord,
    capability: "chat" | "embeddings" | "vision",
  ): void {
    if (!resolved.capabilities[capability]) {
      throw new GatewayRequestError(
        "unsupported_model_capability",
        `Model ${resolved.artifact.id} does not support ${capability} requests.`,
        409,
      );
    }
  }

  private async acquireWorkerForRequest(
    modelId: string,
    capability: "chat" | "embeddings" | "vision",
    traceId: string,
    requiresVision = false,
  ): Promise<ManagedWorker> {
    this.assertAcceptingNewWork();
    const resolved = this.resolveModelRecord(modelId);
    this.ensureModelCapability(resolved, capability);
    if (requiresVision) {
      this.ensureModelCapability(resolved, "vision");
    }

    await this.acquireRequestTurn(resolved.runtimeKeyString, traceId);

    const reuseWorker = (worker: ManagedWorker): ManagedWorker => {
      worker.inflightRequests += 1;
      worker.lastUsedAt = Date.now();

      if (worker.state !== "Busy") {
        const previousState = worker.state;
        worker.state = "Busy";
        this.publish(
          this.createModelStateEvent(worker.artifact, "Busy", {
            previousState,
            reason: "Model is serving a request.",
            runtimeKey: worker.runtimeKey,
            traceId,
          }),
        );
      }

      return worker;
    };

    try {
      const warmWorker = this.getWorkerPool(resolved.runtimeKeyString).find(
        (worker) => worker.state === "Ready" || worker.state === "Busy",
      );
      if (warmWorker) {
        return reuseWorker(warmWorker);
      }

      const existingLoad = this.getPendingLoadPromises(resolved.runtimeKeyString);
      if (existingLoad.length > 0) {
        await Promise.any(existingLoad);

        const refreshedWorker = this.getWorkerPool(resolved.runtimeKeyString).find(
          (worker) => worker.state === "Ready" || worker.state === "Busy",
        );
        if (refreshedWorker) {
          return reuseWorker(refreshedWorker);
        }
      }

      if (this.getWorkerSlotCount(resolved.runtimeKeyString) >= this.#maxWorkersPerModel) {
        throw new GatewayRequestError(
          "worker_busy",
          `Model ${modelId} is busy handling another request.`,
          429,
        );
      }

      const worker = await this.loadWorker(resolved, traceId);
      return reuseWorker(worker);
    } catch (error) {
      this.releaseRequestTurn(resolved.runtimeKeyString);
      throw error;
    }
  }

  private releaseWorkerAfterRequest(worker: ManagedWorker, traceId: string, reason: string): void {
    const workerPresent = this.getWorkerPool(worker.runtimeKeyString).includes(worker);

    if (workerPresent) {
      worker.inflightRequests = Math.max(0, worker.inflightRequests - 1);
      if (worker.inflightRequests === 0 && worker.state !== "Unloading") {
        const previousState = worker.state;
        worker.lastUsedAt = Date.now();
        worker.state = "Ready";
        this.publish(
          this.createModelStateEvent(worker.artifact, "Ready", {
            previousState,
            reason,
            runtimeKey: worker.runtimeKey,
            traceId,
          }),
        );
        this.refreshModelSnapshot(worker.artifact, worker.runtimeKey, worker.runtimeKeyString);
        this.refreshTtl(worker);
      }
    }

    this.releaseRequestTurn(worker.runtimeKeyString);
  }

  private getWorkerBaseUrl(worker: ManagedWorker): string {
    const healthUrl = worker.harness.command.healthUrl;
    if (!healthUrl?.startsWith("http")) {
      throw new GatewayRequestError(
        "unsupported_worker_transport",
        `Model ${worker.artifact.id} is not using an HTTP worker transport.`,
        502,
      );
    }

    return normalizeBaseUrl(healthUrl);
  }

  private async fetchWorkerResponse(
    worker: ManagedWorker,
    endpoint: "/v1/chat/completions" | "/v1/embeddings",
    payload: ChatCompletionsRequest | EmbeddingsRequest,
  ): Promise<Response> {
    if (worker.harness.command.transport === "filesystem") {
      if (endpoint === "/v1/chat/completions") {
        const chatPayload = payload as ChatCompletionsRequest;
        return chatPayload.stream
          ? createFakeChatStreamResponse(chatPayload, randomUUID())
          : new Response(
              JSON.stringify(createFakeChatCompletionResponse(chatPayload, randomUUID())),
              {
                status: 200,
                headers: {
                  "content-type": "application/json; charset=utf-8",
                },
              },
            );
      }

      return new Response(
        JSON.stringify(createFakeEmbeddingsResponse(payload as EmbeddingsRequest)),
        {
          status: 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
          },
        },
      );
    }

    const response = await fetch(`${this.getWorkerBaseUrl(worker)}${endpoint}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    }).catch((error: unknown) => {
      throw new GatewayRequestError(
        "worker_request_failed",
        error instanceof Error ? error.message : "The model worker could not be reached.",
        502,
      );
    });

    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new GatewayRequestError(
        "worker_request_failed",
        message || `The model worker returned HTTP ${response.status}.`,
        response.status >= 400 && response.status < 500 ? response.status : 502,
      );
    }

    return response;
  }

  private insertApiLog(record: {
    traceId: string;
    modelId: string;
    endpoint: string;
    requestIp?: string | undefined;
    promptTokens?: number | undefined;
    completionTokens?: number | undefined;
    ttftMs?: number | undefined;
    totalDurationMs?: number | undefined;
    tokensPerSecond?: number | undefined;
    statusCode?: number | undefined;
    errorMessage?: string | undefined;
    createdAt: string;
  }): void {
    this.#chatRepository.insertApiLog(record);
  }

  private getResidentMemoryBytes(): number {
    return this.getAllWorkers().reduce((total, worker) => total + worker.artifact.sizeBytes, 0);
  }

  private getFailureState(runtimeKeyString: string): WorkerFailureState {
    const existing = this.#workerFailures.get(runtimeKeyString);
    if (existing) {
      return existing;
    }

    const created: WorkerFailureState = {
      failureTimestamps: [],
    };
    this.#workerFailures.set(runtimeKeyString, created);
    return created;
  }

  private clearFailureState(runtimeKeyString: string): void {
    this.#workerFailures.delete(runtimeKeyString);
  }

  private normalizeFailureWindow(state: WorkerFailureState, now: number): number {
    state.failureTimestamps = state.failureTimestamps.filter(
      (timestamp) => now - timestamp <= this.#failureWindowMs,
    );
    return state.failureTimestamps.length;
  }

  private openWorkerCircuit(
    resolved: Pick<ResolvedModelRecord, "artifact">,
    failureState: WorkerFailureState,
    failureCount: number,
    now: number,
    traceId?: string,
  ): void {
    failureState.breakerOpenUntil = now + this.#circuitBreakerCooldownMs;
    failureState.nextRetryAt = undefined;
    this.publishLog(
      "warn",
      `Worker circuit opened for ${resolved.artifact.id} after ${failureCount} failures in ${this.#failureWindowMs}ms.`,
      traceId,
      resolved.artifact.id,
      "gateway",
    );
  }

  private assertWorkerLoadAllowed(resolved: ResolvedModelRecord, traceId: string): void {
    const failureState = this.#workerFailures.get(resolved.runtimeKeyString);
    if (!failureState) {
      return;
    }

    const now = Date.now();
    this.normalizeFailureWindow(failureState, now);

    if (failureState.breakerOpenUntil && failureState.breakerOpenUntil > now) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((failureState.breakerOpenUntil - now) / 1000),
      );
      throw new GatewayRequestError(
        "worker_circuit_open",
        `Model ${resolved.artifact.id} is cooling down after repeated worker failures. Retry in ${retryAfterSeconds}s.`,
        503,
      );
    }

    if (failureState.nextRetryAt && failureState.nextRetryAt > now) {
      failureState.failureTimestamps.push(now);
      failureState.lastReason = "Retry requested during worker backoff window.";
      const failureCount = failureState.failureTimestamps.length;
      if (failureCount >= this.#circuitBreakerThreshold) {
        this.openWorkerCircuit(resolved, failureState, failureCount, now, traceId);
        const retryAfterSeconds = Math.max(1, Math.ceil(this.#circuitBreakerCooldownMs / 1000));
        throw new GatewayRequestError(
          "worker_circuit_open",
          `Model ${resolved.artifact.id} is cooling down after repeated worker failures. Retry in ${retryAfterSeconds}s.`,
          503,
        );
      }

      const retryAfterMs = Math.max(1, failureState.nextRetryAt - now);
      throw new GatewayRequestError(
        "worker_backoff",
        `Model ${resolved.artifact.id} is backing off after a worker failure. Retry in ${retryAfterMs}ms.`,
        503,
      );
    }
  }

  private recordWorkerFailure(
    resolved: Pick<ResolvedModelRecord, "artifact" | "runtimeKeyString">,
    traceId: string,
    reason: string,
  ): void {
    const now = Date.now();
    const failureState = this.getFailureState(resolved.runtimeKeyString);
    this.normalizeFailureWindow(failureState, now);
    failureState.failureTimestamps.push(now);
    failureState.lastReason = reason;
    const failureCount = failureState.failureTimestamps.length;

    failureState.nextRetryAt =
      now +
      Math.min(
        this.#failureBackoffMaxMs,
        Math.max(this.#failureBackoffMs, this.#failureBackoffMs * failureCount),
      );

    if (failureCount >= this.#circuitBreakerThreshold) {
      this.openWorkerCircuit(resolved, failureState, failureCount, now, traceId);
    }
  }

  private async enforceResidentMemoryBudget(
    resolved: ResolvedModelRecord,
    traceId: string,
  ): Promise<void> {
    if (this.#maxResidentMemoryBytes <= 0) {
      return;
    }

    if (resolved.artifact.sizeBytes > this.#maxResidentMemoryBytes) {
      throw new GatewayRequestError(
        "resource_exhausted",
        `Model ${resolved.artifact.id} exceeds the configured resident memory budget.`,
        503,
      );
    }

    let residentMemoryBytes = this.getResidentMemoryBytes();
    if (residentMemoryBytes + resolved.artifact.sizeBytes <= this.#maxResidentMemoryBytes) {
      return;
    }

    const evictionCandidates = this.getAllWorkers()
      .filter(
        (worker) =>
          worker.runtimeKeyString !== resolved.runtimeKeyString &&
          worker.inflightRequests === 0 &&
          worker.state === "Ready",
      )
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt);

    for (const worker of evictionCandidates) {
      if (residentMemoryBytes + resolved.artifact.sizeBytes <= this.#maxResidentMemoryBytes) {
        break;
      }

      this.publishLog(
        "info",
        `Evicting ${worker.artifact.id} under resident memory pressure to load ${resolved.artifact.id}.`,
        traceId,
        worker.artifact.id,
        "gateway",
      );
      residentMemoryBytes -= worker.artifact.sizeBytes;
      await this.stopWorker(
        worker,
        traceId,
        `Evicted under resident memory pressure to load ${resolved.artifact.id}.`,
      );
    }

    if (residentMemoryBytes + resolved.artifact.sizeBytes > this.#maxResidentMemoryBytes) {
      throw new GatewayRequestError(
        "resource_exhausted",
        `Not enough resident memory budget to load ${resolved.artifact.id}.`,
        503,
      );
    }
  }

  private async loadWorker(resolved: ResolvedModelRecord, traceId: string): Promise<ManagedWorker> {
    this.assertWorkerLoadAllowed(resolved, traceId);
    const pendingLoads = this.#loadPromises.get(resolved.runtimeKeyString) ?? new Set();
    if (this.getWorkerSlotCount(resolved.runtimeKeyString) >= this.#maxWorkersPerModel) {
      throw new GatewayRequestError(
        "worker_busy",
        `Model ${resolved.artifact.id} is busy handling another request.`,
        429,
      );
    }

    this.incrementPendingLoadReservation(resolved.runtimeKeyString);
    let resolveLoad: (worker: ManagedWorker) => void = () => undefined;
    let rejectLoad: (error: unknown) => void = () => undefined;
    const loadPromise = new Promise<ManagedWorker>((resolve, reject) => {
      resolveLoad = resolve;
      rejectLoad = reject;
    });
    pendingLoads.add(loadPromise);
    this.#loadPromises.set(resolved.runtimeKeyString, pendingLoads);

    let worker: ManagedWorker | undefined;
    let reservationReleased = false;
    const releaseReservation = () => {
      if (reservationReleased) {
        return;
      }

      reservationReleased = true;
      this.decrementPendingLoadReservation(resolved.runtimeKeyString);
    };

    void (async () => {
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

        await this.enforceResidentMemoryBudget(resolved, traceId);

        const harness = await createLlamaCppHarness(this.#adapter, {
          artifact: resolved.artifact,
          profile: resolved.profile,
          runtimeKey: resolved.runtimeKey,
          supportRoot: this.#supportRoot,
        });

        if (this.#stopping) {
          await harness.stop(this.#workerStopTimeoutMs).catch(() => undefined);
          throw new GatewayRequestError(
            "gateway_stopping",
            "The gateway is shutting down and is not accepting new work.",
            503,
          );
        }

        worker = {
          artifact: resolved.artifact,
          evictionTimer: undefined,
          harness,
          inflightRequests: 0,
          intentionalStop: false,
          lastUsedAt: Date.now(),
          loadedAt: nowIso(),
          profile: resolved.profile,
          runtimeKey: resolved.runtimeKey,
          runtimeKeyString: resolved.runtimeKeyString,
          state: "Loading",
        };

        this.addWorkerToPool(worker);
        releaseReservation();
        this.attachWorkerLogging(worker);
        this.attachWorkerExitListener(worker);
        this.persistEngineRecord(harness.command);

        if (this.#stopping) {
          await this.stopWorker(
            worker,
            traceId,
            "Gateway shutdown interrupted model startup before readiness.",
          );
          throw new GatewayRequestError(
            "gateway_stopping",
            "The gateway is shutting down and is not accepting new work.",
            503,
          );
        }

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

        if (this.#stopping) {
          await this.stopWorker(
            worker,
            traceId,
            "Gateway shutdown interrupted model startup after readiness.",
          );
          throw new GatewayRequestError(
            "gateway_stopping",
            "The gateway is shutting down and is not accepting new work.",
            503,
          );
        }

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
        this.clearFailureState(resolved.runtimeKeyString);
        this.refreshModelSnapshot(
          resolved.artifact,
          resolved.runtimeKey,
          resolved.runtimeKeyString,
        );
        resolveLoad(worker);
      } catch (error) {
        if (worker) {
          worker.intentionalStop = true;
          worker.evictionTimer?.refresh();
          await worker.harness.stop().catch(() => undefined);
          this.removeWorkerFromPool(worker);
        }
        releaseReservation();

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
        this.recordWorkerFailure(
          resolved,
          traceId,
          error instanceof Error ? error.message : "Worker load failed.",
        );
        this.refreshModelSnapshot(
          resolved.artifact,
          resolved.runtimeKey,
          resolved.runtimeKeyString,
          error instanceof Error ? error.message : "Worker load failed.",
        );
        rejectLoad(error);
      } finally {
        pendingLoads.delete(loadPromise);
        if (pendingLoads.size === 0) {
          this.#loadPromises.delete(resolved.runtimeKeyString);
        }
      }
    })();

    return await loadPromise;
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

    await worker.harness.stop(this.#workerStopTimeoutMs).catch((error: unknown) => {
      this.publishLog(
        "warn",
        error instanceof Error ? error.message : "Worker stop failed.",
        traceId,
        worker.artifact.id,
        "gateway",
      );
    });
    this.removeWorkerFromPool(worker);

    this.publish(
      this.createModelStateEvent(worker.artifact, "CoolingDown", {
        previousState: "Unloading",
        reason,
        runtimeKey: worker.runtimeKey,
        traceId,
      }),
    );
    this.refreshModelSnapshot(worker.artifact, worker.runtimeKey, worker.runtimeKeyString);
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
      streamName: "stdout" | "stderr",
      source: "worker" | "system",
    ) => {
      const reader = createInterface({ input: stream });

      reader.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) {
          return;
        }

        let message = trimmed;
        let resolvedLevel: "debug" | "info" | "warn" | "error" =
          streamName === "stderr" ? classifyStderrLogLevel(trimmed) : "info";

        try {
          const parsed = JSON.parse(trimmed) as {
            level?: "debug" | "info" | "warn" | "error";
            phase?: string;
            reason?: string;
          };
          resolvedLevel = parsed.level ?? resolvedLevel;
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

    attach(worker.harness.child.stdout, "stdout", "worker");
    attach(worker.harness.child.stderr, "stderr", "worker");
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

      this.removeWorkerFromPool(worker);
      this.publishLog(
        "error",
        `Worker exited unexpectedly (${code ?? "null"}${signal ? `, ${signal}` : ""}).`,
        normalizeTraceId(undefined),
        worker.artifact.id,
        "worker",
      );
      this.recordWorkerFailure(
        {
          artifact: worker.artifact,
          runtimeKeyString: worker.runtimeKeyString,
        },
        normalizeTraceId(undefined),
        `Worker exited unexpectedly (${code ?? "null"}${signal ? `, ${signal}` : ""}).`,
      );
      this.refreshModelSnapshot(
        worker.artifact,
        worker.runtimeKey,
        worker.runtimeKeyString,
        `Worker exited unexpectedly (${code ?? "null"}${signal ? `, ${signal}` : ""}).`,
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

    const storedId = this.#enginesRepository.upsert({
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
    this.#enginesRepository.setActive(DEFAULT_ENGINE_TYPE, storedId);
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
    const activeWorkers = this.getAllWorkers().length;
    const residentMemoryBytes = this.getResidentMemoryBytes();
    const queuedRequests = this.getAllLoadPromises().length + this.getTotalQueuedRequestCount();

    return {
      type: "METRICS_TICK",
      ts: nowIso(),
      traceId: normalizeTraceId(undefined),
      payload: {
        activeWorkers,
        queuedRequests,
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
