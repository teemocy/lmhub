import { z } from "zod";

import {
  fileSystemPathSchema,
  isoDatetimeSchema,
  nonEmptyStringSchema,
  positiveIntegerSchema,
} from "./common.js";
import { type GatewayDiscoveryFile, gatewayDiscoveryFileSchema } from "./config.js";
import {
  engineTypeSchema,
  modelFormatSchema,
  modelSourceKindSchema,
  runtimeRoleSchema,
} from "./models.js";

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
export type DesktopModelRecord = z.infer<typeof desktopModelRecordSchema>;
export type DesktopModelLibrary = z.infer<typeof desktopModelLibrarySchema>;
export type DesktopLocalModelImportRequest = z.infer<typeof desktopLocalModelImportRequestSchema>;
export type DesktopLocalModelImportResponse = z.infer<typeof desktopLocalModelImportResponseSchema>;
export type DesktopShellPhase = z.infer<typeof desktopShellPhaseSchema>;
export type DesktopShellState = z.infer<typeof desktopShellStateSchema>;
