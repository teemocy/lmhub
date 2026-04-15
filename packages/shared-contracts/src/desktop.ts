import { z } from "zod";

import {
  fileSystemPathSchema,
  isoDatetimeSchema,
  jsonRecordSchema,
  nonEmptyStringSchema,
  positiveIntegerSchema,
} from "./common.js";
import { type GatewayDiscoveryFile, gatewayDiscoveryFileSchema } from "./config.js";
import {
  capabilityOverridesSchema,
  engineTypeSchema,
  flashAttentionTypeSchema,
  modelFormatSchema,
  modelSourceKindSchema,
  poolingMethodSchema,
  runtimeRoleSchema,
} from "./models.js";
import {
  openAiMessageContentPartSchema,
  openAiMessageSchema,
  openAiToolCallSchema,
} from "./openai.js";
import { apiLogRecordSchema, chatMessageSchema, chatSessionSchema } from "./persistence.js";

export const desktopModelRuntimeStateSchema = z.enum([
  "idle",
  "queued",
  "loading",
  "ready",
  "evicting",
  "error",
]);

export const modelSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  engine: z.string(),
  state: desktopModelRuntimeStateSchema,
  sizeLabel: z.string(),
  tags: z.array(z.string()).default([]),
  capabilities: z.array(z.string()).default([]),
  contextLength: z.number().int().positive().optional(),
  description: z.string().optional(),
  lastUsedAt: isoDatetimeSchema.optional(),
});

export const publicModelListSchema = z.object({
  object: z.literal("list"),
  data: z.array(modelSummarySchema),
});

export const desktopModelArtifactStatusSchema = z.enum(["available", "missing"]);

export const desktopEngineChannelSchema = z.enum(["stable", "nightly"]);

export const desktopEngineRecordSchema = z.object({
  id: nonEmptyStringSchema,
  engineType: engineTypeSchema,
  version: nonEmptyStringSchema,
  channel: desktopEngineChannelSchema,
  installed: z.boolean(),
  active: z.boolean(),
  binaryPath: fileSystemPathSchema.optional(),
  installedAt: isoDatetimeSchema.optional(),
  compatibilityNotes: nonEmptyStringSchema.optional(),
});

export const desktopEngineListSchema = z.object({
  object: z.literal("list"),
  data: z.array(desktopEngineRecordSchema),
});

export const desktopEngineInstallRequestSchema = z.union([
  z.object({
    engineType: z.literal("llama.cpp").optional(),
    action: z.literal("download-latest-metal"),
    versionTag: nonEmptyStringSchema.optional(),
  }),
  z.object({
    engineType: z.literal("llama.cpp").optional(),
    action: z.literal("import-local-binary"),
    filePath: fileSystemPathSchema,
    versionTag: nonEmptyStringSchema.optional(),
  }),
  z.object({
    engineType: z.literal("llama.cpp").optional(),
    action: z.literal("activate-installed-version"),
    versionTag: nonEmptyStringSchema,
  }),
  z.object({
    engineType: z.literal("mlx"),
    action: z.literal("install-managed-runtime"),
    versionTag: nonEmptyStringSchema.optional(),
  }),
  z.object({
    engineType: z.literal("mlx"),
    action: z.literal("activate-installed-version"),
    versionTag: nonEmptyStringSchema,
  }),
]);

export const desktopEngineInstallResponseSchema = z.object({
  accepted: z.boolean(),
  engine: desktopEngineRecordSchema,
  notes: z.array(z.string()).default([]),
});

export const desktopModelRecordSchema = z.object({
  id: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  displayName: nonEmptyStringSchema,
  engineType: engineTypeSchema,
  state: desktopModelRuntimeStateSchema,
  loaded: z.boolean(),
  artifactStatus: desktopModelArtifactStatusSchema,
  sizeBytes: z.number().int().nonnegative(),
  format: modelFormatSchema,
  capabilities: z.array(nonEmptyStringSchema).default([]),
  capabilityOverrides: capabilityOverridesSchema.default({}),
  role: runtimeRoleSchema,
  tags: z.array(nonEmptyStringSchema).default([]),
  localPath: fileSystemPathSchema,
  sourceKind: modelSourceKindSchema,
  pinned: z.boolean(),
  defaultTtlMs: positiveIntegerSchema,
  architecture: nonEmptyStringSchema.optional(),
  quantization: nonEmptyStringSchema.optional(),
  contextLength: positiveIntegerSchema.optional(),
  parameterCount: z.number().int().nonnegative().optional(),
  tokenizer: nonEmptyStringSchema.optional(),
  batchSize: positiveIntegerSchema.optional(),
  ubatchSize: positiveIntegerSchema.optional(),
  gpuLayers: positiveIntegerSchema.optional(),
  parallelSlots: positiveIntegerSchema.optional(),
  flashAttentionType: flashAttentionTypeSchema.optional(),
  poolingMethod: poolingMethodSchema.optional(),
  checksumSha256: nonEmptyStringSchema.optional(),
  engineVersion: nonEmptyStringSchema.optional(),
  engineChannel: desktopEngineChannelSchema.optional(),
  lastUsedAt: isoDatetimeSchema.optional(),
  createdAt: isoDatetimeSchema,
  updatedAt: isoDatetimeSchema,
  errorMessage: nonEmptyStringSchema.optional(),
});

export const desktopModelLibrarySchema = z.object({
  object: z.literal("list"),
  data: z.array(desktopModelRecordSchema),
});

export const desktopLocalModelImportRequestSchema = z.object({
  filePath: fileSystemPathSchema,
  displayName: nonEmptyStringSchema.max(120).optional(),
});

export const desktopLocalModelImportResponseSchema = z.object({
  created: z.boolean(),
  model: desktopModelRecordSchema,
});

export const desktopModelConfigUpdateRequestSchema = z.object({
  displayName: nonEmptyStringSchema.max(120).optional(),
  pinned: z.boolean().optional(),
  defaultTtlMs: positiveIntegerSchema.optional(),
  contextLength: positiveIntegerSchema.optional(),
  batchSize: positiveIntegerSchema.optional(),
  ubatchSize: positiveIntegerSchema.optional(),
  gpuLayers: positiveIntegerSchema.optional(),
  parallelSlots: positiveIntegerSchema.optional(),
  flashAttentionType: flashAttentionTypeSchema.optional(),
  poolingMethod: poolingMethodSchema.optional(),
  capabilityOverrides: capabilityOverridesSchema.optional(),
});

export const desktopModelConfigUpdateResponseSchema = z.object({
  model: desktopModelRecordSchema,
});

export const desktopChatSessionListSchema = z.object({
  object: z.literal("list"),
  data: z.array(chatSessionSchema),
});

export const desktopChatMessageListSchema = z.object({
  object: z.literal("list"),
  data: z.array(chatMessageSchema),
});

export const desktopChatSessionUpsertRequestSchema = z.object({
  id: nonEmptyStringSchema.optional(),
  modelId: nonEmptyStringSchema.optional(),
  title: z.string().optional(),
  systemPrompt: z.string().optional(),
  metadata: jsonRecordSchema.optional(),
});

export const desktopChatRunRequestSchema = z.object({
  sessionId: nonEmptyStringSchema.optional(),
  model: nonEmptyStringSchema,
  systemPrompt: z.string().optional(),
  message: z.union([z.string().min(1), z.array(openAiMessageContentPartSchema).min(1)]),
  clientRequestId: nonEmptyStringSchema.optional(),
  maxTokens: positiveIntegerSchema.optional(),
});

export const desktopChatStreamEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("start"),
    clientRequestId: nonEmptyStringSchema,
    sessionId: nonEmptyStringSchema,
  }),
  z.object({
    type: z.literal("delta"),
    clientRequestId: nonEmptyStringSchema,
    sessionId: nonEmptyStringSchema,
    contentDelta: z.string().optional(),
    reasoningDelta: z.string().optional(),
    toolCalls: z.array(openAiToolCallSchema).optional(),
  }),
  z.object({
    type: z.literal("done"),
    clientRequestId: nonEmptyStringSchema,
    sessionId: nonEmptyStringSchema,
  }),
  z.object({
    type: z.literal("error"),
    clientRequestId: nonEmptyStringSchema,
    sessionId: nonEmptyStringSchema.optional(),
    errorMessage: nonEmptyStringSchema,
  }),
]);

export const desktopChatRunResponseSchema = z.object({
  session: chatSessionSchema,
  userMessage: chatMessageSchema,
  assistantMessage: chatMessageSchema,
  response: z.object({
    id: nonEmptyStringSchema,
    object: z.literal("chat.completion"),
    created: z.number().int().nonnegative(),
    model: nonEmptyStringSchema,
    choices: z.array(
      z.object({
        index: z.number().int().nonnegative(),
        finish_reason: z.string().nullable(),
        message: openAiMessageSchema,
      }),
    ),
    usage: z
      .object({
        prompt_tokens: positiveIntegerSchema,
        completion_tokens: positiveIntegerSchema,
        total_tokens: positiveIntegerSchema,
      })
      .optional(),
  }),
});

export const desktopApiLogListSchema = z.object({
  object: z.literal("list"),
  data: z.array(apiLogRecordSchema),
});

export const desktopProviderSearchItemSchema = z.object({
  id: nonEmptyStringSchema,
  provider: z.enum(["huggingface", "modelscope"]),
  providerModelId: nonEmptyStringSchema,
  title: nonEmptyStringSchema,
  author: nonEmptyStringSchema.optional(),
  summary: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(nonEmptyStringSchema).default([]),
  formats: z.array(nonEmptyStringSchema).default([]),
  downloads: z.number().int().nonnegative().optional(),
  likes: z.number().int().nonnegative().optional(),
  updatedAt: isoDatetimeSchema.optional(),
  repositoryUrl: z.string().url(),
});

export const desktopProviderCatalogFileSchema = z.object({
  id: nonEmptyStringSchema,
  artifactId: nonEmptyStringSchema,
  artifactName: nonEmptyStringSchema,
  downloadUrl: z.string().url().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  quantization: nonEmptyStringSchema.optional(),
  architecture: nonEmptyStringSchema.optional(),
  checksumSha256: nonEmptyStringSchema.optional(),
  auxiliary: z.boolean().default(false),
  auxiliaryKind: nonEmptyStringSchema.optional(),
  metadata: jsonRecordSchema.default({}),
});

export const desktopProviderCatalogVariantSchema = z.object({
  id: nonEmptyStringSchema,
  label: nonEmptyStringSchema,
  primaryArtifactId: nonEmptyStringSchema,
  files: z.array(desktopProviderCatalogFileSchema),
  totalSizeBytes: z.number().int().nonnegative().optional(),
});

export const desktopProviderCatalogDetailSchema = desktopProviderSearchItemSchema.extend({
  variants: z.array(desktopProviderCatalogVariantSchema),
});

export const desktopProviderSearchResultSchema = z.object({
  object: z.literal("list"),
  data: z.array(desktopProviderSearchItemSchema),
  warnings: z.array(z.string()).default([]),
});

export const desktopProviderCatalogDetailResponseSchema = z.object({
  object: z.literal("model"),
  data: desktopProviderCatalogDetailSchema,
  warnings: z.array(z.string()).default([]),
});

export const desktopDownloadFileSchema = z.object({
  id: nonEmptyStringSchema,
  artifactId: nonEmptyStringSchema,
  artifactName: nonEmptyStringSchema,
  status: z.enum(["pending", "downloading", "paused", "completed", "error"]),
  progress: z.number().int().min(0).max(100),
  downloadedBytes: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative().optional(),
  destinationPath: fileSystemPathSchema.optional(),
  updatedAt: isoDatetimeSchema,
  errorMessage: z.string().optional(),
  auxiliary: z.boolean().default(false),
  auxiliaryKind: nonEmptyStringSchema.optional(),
  metadata: jsonRecordSchema.default({}),
});

export const desktopDownloadTaskSchema = z.object({
  id: nonEmptyStringSchema,
  modelId: nonEmptyStringSchema.optional(),
  provider: z.enum(["huggingface", "modelscope"]),
  providerModelId: nonEmptyStringSchema,
  title: nonEmptyStringSchema,
  artifactName: nonEmptyStringSchema,
  status: z.enum(["pending", "downloading", "paused", "completed", "error"]),
  progress: z.number().int().min(0).max(100),
  downloadedBytes: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative().optional(),
  fileCount: z.number().int().positive(),
  completedFileCount: z.number().int().nonnegative(),
  errorFileCount: z.number().int().nonnegative(),
  rateBytesPerSecond: z.number().nonnegative().optional(),
  destinationPath: fileSystemPathSchema.optional(),
  updatedAt: isoDatetimeSchema,
  errorMessage: z.string().optional(),
  files: z.array(desktopDownloadFileSchema).min(1),
});

export const desktopDownloadListSchema = z.object({
  object: z.literal("list"),
  data: z.array(desktopDownloadTaskSchema),
});

export const desktopDownloadCreateFileSchema = z.object({
  artifactId: nonEmptyStringSchema,
  artifactName: nonEmptyStringSchema,
  downloadUrl: z.string().url().optional(),
  checksumSha256: nonEmptyStringSchema.optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  auxiliary: z.boolean().default(false),
  auxiliaryKind: nonEmptyStringSchema.optional(),
  metadata: jsonRecordSchema.default({}),
});

export const desktopDownloadCreateRequestSchema = z.object({
  provider: z.enum(["huggingface", "modelscope"]),
  providerModelId: nonEmptyStringSchema,
  artifactId: nonEmptyStringSchema,
  title: nonEmptyStringSchema,
  artifactName: nonEmptyStringSchema,
  taskGroupId: nonEmptyStringSchema.optional(),
  downloadUrl: z.string().url().optional(),
  destinationPath: fileSystemPathSchema.optional(),
  checksumSha256: nonEmptyStringSchema.optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  metadata: jsonRecordSchema.default({}),
  files: z.array(desktopDownloadCreateFileSchema).min(1).optional(),
});

export const desktopDownloadActionResponseSchema = z.object({
  accepted: z.boolean(),
  task: desktopDownloadTaskSchema,
});

export const desktopDownloadDeleteResponseSchema = z.object({
  accepted: z.boolean(),
  id: nonEmptyStringSchema,
});

export const desktopRuntimeContextSchema = z.object({
  desktop: z.object({
    closeToTray: z.boolean(),
    autoLaunchGateway: z.boolean(),
    theme: z.enum(["system", "light", "dark"]),
    controlAuthHeaderName: z.enum(["authorization", "x-api-key", "api-key"]),
    controlAuthToken: nonEmptyStringSchema.optional(),
  }),
  gateway: z.object({
    enableLan: z.boolean(),
    authRequired: z.boolean(),
    publicHost: nonEmptyStringSchema,
    publicPort: positiveIntegerSchema,
    controlHost: nonEmptyStringSchema,
    corsAllowlist: z.array(nonEmptyStringSchema).default([]),
    defaultModelTtlMs: positiveIntegerSchema,
    maxActiveModelsInMemory: z.number().int().nonnegative(),
    localModelsDir: fileSystemPathSchema,
    publicAuthToken: nonEmptyStringSchema.optional(),
    controlAuthHeaderName: z.enum(["authorization", "x-api-key", "api-key"]),
  }),
  system: z.object({
    platform: z.enum(["darwin", "linux", "win32"]),
    arch: nonEmptyStringSchema,
  }),
  mlx: z.object({
    supported: z.boolean(),
    installed: z.boolean(),
    activeVersion: nonEmptyStringSchema.optional(),
    activeMlxVersion: nonEmptyStringSchema.optional(),
    activeMlxLmVersion: nonEmptyStringSchema.optional(),
    latestMlxVersion: nonEmptyStringSchema.optional(),
    latestMlxLmVersion: nonEmptyStringSchema.optional(),
    updateAvailable: z.boolean().default(false),
    statusMessage: z.string().optional(),
  }),
  files: z.object({
    desktopConfigFile: fileSystemPathSchema,
    gatewayConfigFile: fileSystemPathSchema,
  }),
});

export const gatewayDiscoverySchema = gatewayDiscoveryFileSchema;
export const rendererDiscoverySchema = gatewayDiscoveryFileSchema;

export const desktopShellPhaseSchema = z.enum([
  "idle",
  "launching",
  "waiting_for_discovery",
  "connecting",
  "connected",
  "error",
  "stopped",
]);

export const desktopShellStateSchema = z.object({
  phase: desktopShellPhaseSchema,
  progress: z.number().min(0).max(100),
  message: z.string(),
  discovery: rendererDiscoverySchema.nullable(),
  lastError: z.string().nullable(),
  startedAt: isoDatetimeSchema.nullable(),
  lastEventAt: isoDatetimeSchema.nullable(),
});

export type GatewayDiscovery = GatewayDiscoveryFile;
export type RendererDiscovery = GatewayDiscoveryFile;
export type DesktopModelRuntimeState = z.infer<typeof desktopModelRuntimeStateSchema>;
export type ModelSummary = z.infer<typeof modelSummarySchema>;
export type PublicModelList = z.infer<typeof publicModelListSchema>;
export type DesktopModelArtifactStatus = z.infer<typeof desktopModelArtifactStatusSchema>;
export type DesktopEngineChannel = z.infer<typeof desktopEngineChannelSchema>;
export type DesktopEngineRecord = z.infer<typeof desktopEngineRecordSchema>;
export type DesktopEngineList = z.infer<typeof desktopEngineListSchema>;
export type DesktopEngineInstallRequest = z.infer<typeof desktopEngineInstallRequestSchema>;
export type DesktopEngineInstallResponse = z.infer<typeof desktopEngineInstallResponseSchema>;
export type DesktopModelRecord = z.infer<typeof desktopModelRecordSchema>;
export type DesktopModelLibrary = z.infer<typeof desktopModelLibrarySchema>;
export type DesktopLocalModelImportRequest = z.infer<typeof desktopLocalModelImportRequestSchema>;
export type DesktopLocalModelImportResponse = z.infer<typeof desktopLocalModelImportResponseSchema>;
export type DesktopModelConfigUpdateRequest = z.infer<typeof desktopModelConfigUpdateRequestSchema>;
export type DesktopModelConfigUpdateResponse = z.infer<
  typeof desktopModelConfigUpdateResponseSchema
>;
export type DesktopChatSessionList = z.infer<typeof desktopChatSessionListSchema>;
export type DesktopChatMessageList = z.infer<typeof desktopChatMessageListSchema>;
export type DesktopChatSessionUpsertRequest = z.infer<typeof desktopChatSessionUpsertRequestSchema>;
export type DesktopChatRunRequest = z.infer<typeof desktopChatRunRequestSchema>;
export type DesktopChatRunResponse = z.infer<typeof desktopChatRunResponseSchema>;
export type DesktopChatStreamEvent = z.infer<typeof desktopChatStreamEventSchema>;
export type DesktopApiLogList = z.infer<typeof desktopApiLogListSchema>;
export type DesktopProviderSearchItem = z.infer<typeof desktopProviderSearchItemSchema>;
export type DesktopProviderSearchResult = z.infer<typeof desktopProviderSearchResultSchema>;
export type DesktopProviderCatalogFile = z.infer<typeof desktopProviderCatalogFileSchema>;
export type DesktopProviderCatalogVariant = z.infer<typeof desktopProviderCatalogVariantSchema>;
export type DesktopProviderCatalogDetail = z.infer<typeof desktopProviderCatalogDetailSchema>;
export type DesktopProviderCatalogDetailResponse = z.infer<
  typeof desktopProviderCatalogDetailResponseSchema
>;
export type DesktopDownloadFile = z.infer<typeof desktopDownloadFileSchema>;
export type DesktopDownloadTask = z.infer<typeof desktopDownloadTaskSchema>;
export type DesktopDownloadList = z.infer<typeof desktopDownloadListSchema>;
export type DesktopDownloadCreateFile = z.infer<typeof desktopDownloadCreateFileSchema>;
export type DesktopDownloadCreateRequest = z.infer<typeof desktopDownloadCreateRequestSchema>;
export type DesktopDownloadActionResponse = z.infer<typeof desktopDownloadActionResponseSchema>;
export type DesktopDownloadDeleteResponse = z.infer<typeof desktopDownloadDeleteResponseSchema>;
export type DesktopRuntimeContext = z.infer<typeof desktopRuntimeContextSchema>;
export type DesktopShellPhase = z.infer<typeof desktopShellPhaseSchema>;
export type DesktopShellState = z.infer<typeof desktopShellStateSchema>;
