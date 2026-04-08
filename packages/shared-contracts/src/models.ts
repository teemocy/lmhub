import { z } from "zod";

import {
  CONTRACT_SCHEMA_VERSION,
  fileSystemPathSchema,
  isoDatetimeSchema,
  jsonRecordSchema,
  nonEmptyStringSchema,
  positiveIntegerSchema,
  schemaVersionSchema,
} from "./common.js";

export const engineTypeSchema = z.enum(["llama.cpp", "mlx", "unknown"]);
export const modelFormatSchema = z.enum(["gguf", "mlx", "directory", "unknown"]);
export const modelSourceKindSchema = z.enum([
  "local",
  "huggingface",
  "modelscope",
  "manual",
  "unknown",
]);
export const runtimeRoleSchema = z.enum([
  "chat",
  "embeddings",
  "rerank",
  "vision",
  "audio",
  "tooling",
]);

export const capabilitySetSchema = z.object({
  chat: z.boolean(),
  embeddings: z.boolean(),
  tools: z.boolean(),
  streaming: z.boolean(),
  vision: z.boolean(),
  audioTranscription: z.boolean(),
  audioSpeech: z.boolean(),
  rerank: z.boolean(),
  promptCache: z.boolean(),
});

export const capabilityOverridesSchema = capabilitySetSchema.omit({ promptCache: true }).partial();

export const flashAttentionTypeSchema = z.enum(["auto", "enabled", "disabled"]);

export const ggufMetadataSchema = z.object({
  schemaVersion: schemaVersionSchema.default(CONTRACT_SCHEMA_VERSION),
  architecture: nonEmptyStringSchema.optional(),
  quantization: nonEmptyStringSchema.optional(),
  contextLength: positiveIntegerSchema.optional(),
  parameterCount: z.number().int().nonnegative().optional(),
  tensorCount: positiveIntegerSchema.optional(),
  tokenizer: nonEmptyStringSchema.optional(),
  metadata: jsonRecordSchema.default({}),
});

export const modelSourceSchema = z.object({
  kind: modelSourceKindSchema,
  remoteUrl: z.string().url().optional(),
  revision: nonEmptyStringSchema.optional(),
  checksumSha256: nonEmptyStringSchema.optional(),
});

export const modelArtifactSchema = z.object({
  schemaVersion: schemaVersionSchema.default(CONTRACT_SCHEMA_VERSION),
  id: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  localPath: fileSystemPathSchema,
  format: modelFormatSchema,
  sizeBytes: z.number().int().nonnegative(),
  architecture: nonEmptyStringSchema.optional(),
  quantization: nonEmptyStringSchema.optional(),
  createdAt: isoDatetimeSchema,
  updatedAt: isoDatetimeSchema,
  source: modelSourceSchema.default({ kind: "local" }),
  metadata: ggufMetadataSchema.default({ schemaVersion: CONTRACT_SCHEMA_VERSION, metadata: {} }),
  capabilities: capabilitySetSchema,
  tags: z.array(nonEmptyStringSchema).default([]),
});

export const modelProfileSchema = z.object({
  schemaVersion: schemaVersionSchema.default(CONTRACT_SCHEMA_VERSION),
  id: nonEmptyStringSchema,
  modelId: nonEmptyStringSchema,
  displayName: nonEmptyStringSchema,
  engineType: engineTypeSchema.default("llama.cpp"),
  pinned: z.boolean().default(false),
  defaultTtlMs: positiveIntegerSchema.default(900000),
  promptCacheKey: nonEmptyStringSchema.optional(),
  role: runtimeRoleSchema.default("chat"),
  parameterOverrides: jsonRecordSchema.default({}),
  capabilityOverrides: capabilityOverridesSchema.optional(),
  createdAt: isoDatetimeSchema,
  updatedAt: isoDatetimeSchema,
});

export type CapabilitySet = z.infer<typeof capabilitySetSchema>;
export type CapabilityOverrides = z.infer<typeof capabilityOverridesSchema>;
export type FlashAttentionType = z.infer<typeof flashAttentionTypeSchema>;
export type GgufMetadata = z.infer<typeof ggufMetadataSchema>;
export type ModelArtifact = z.infer<typeof modelArtifactSchema>;
export type ModelProfile = z.infer<typeof modelProfileSchema>;
export type EngineType = z.infer<typeof engineTypeSchema>;
export type ModelFormat = z.infer<typeof modelFormatSchema>;
export type RuntimeRole = z.infer<typeof runtimeRoleSchema>;
