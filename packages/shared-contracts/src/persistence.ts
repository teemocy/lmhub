import { z } from "zod";

import {
  fileSystemPathSchema,
  isoDatetimeSchema,
  jsonRecordSchema,
  nonEmptyStringSchema,
} from "./common.js";
import { capabilitySetSchema, engineTypeSchema, modelSourceKindSchema } from "./models.js";
import { openAiRoleSchema, openAiToolCallSchema } from "./openai.js";

export const engineVersionRecordSchema = z.object({
  id: nonEmptyStringSchema,
  engineType: engineTypeSchema,
  versionTag: nonEmptyStringSchema,
  binaryPath: fileSystemPathSchema,
  isActive: z.boolean().default(false),
  compatibilityNotes: z.string().optional(),
  capabilities: capabilitySetSchema.partial().default({}),
  installedAt: isoDatetimeSchema,
});

export const downloadTaskSchema = z.object({
  id: nonEmptyStringSchema,
  modelId: nonEmptyStringSchema.optional(),
  provider: modelSourceKindSchema.default("manual"),
  url: z.string().url(),
  totalBytes: z.number().int().nonnegative().optional(),
  downloadedBytes: z.number().int().nonnegative().default(0),
  status: z.enum(["pending", "downloading", "paused", "completed", "error"]),
  checksumSha256: nonEmptyStringSchema.optional(),
  errorMessage: z.string().optional(),
  metadata: jsonRecordSchema.default({}),
  createdAt: isoDatetimeSchema,
  updatedAt: isoDatetimeSchema,
});

export const chatSessionSchema = z.object({
  id: nonEmptyStringSchema,
  title: z.string().optional(),
  modelId: nonEmptyStringSchema.optional(),
  systemPrompt: z.string().optional(),
  metadata: jsonRecordSchema.default({}),
  createdAt: isoDatetimeSchema,
  updatedAt: isoDatetimeSchema,
});

export const chatMessageSchema = z.object({
  id: nonEmptyStringSchema,
  sessionId: nonEmptyStringSchema,
  role: openAiRoleSchema,
  content: z.string().nullable(),
  toolCalls: z.array(openAiToolCallSchema).default([]),
  tokensCount: z.number().int().nonnegative().optional(),
  metadata: jsonRecordSchema.default({}),
  createdAt: isoDatetimeSchema,
});

export const apiLogRecordSchema = z.object({
  id: z.number().int().positive().optional(),
  traceId: nonEmptyStringSchema.optional(),
  modelId: nonEmptyStringSchema.optional(),
  endpoint: nonEmptyStringSchema,
  requestIp: nonEmptyStringSchema.optional(),
  promptTokens: z.number().int().nonnegative().optional(),
  completionTokens: z.number().int().nonnegative().optional(),
  ttftMs: z.number().int().nonnegative().optional(),
  totalDurationMs: z.number().int().nonnegative().optional(),
  tokensPerSecond: z.number().nonnegative().optional(),
  statusCode: z.number().int().nonnegative().optional(),
  errorMessage: z.string().optional(),
  createdAt: isoDatetimeSchema,
});

export type EngineVersionRecord = z.infer<typeof engineVersionRecordSchema>;
export type DownloadTask = z.infer<typeof downloadTaskSchema>;
export type ChatSession = z.infer<typeof chatSessionSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ApiLogRecord = z.infer<typeof apiLogRecordSchema>;
