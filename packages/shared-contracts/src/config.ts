import os from "node:os";
import path from "node:path";
import { z } from "zod";

import {
  CONTRACT_SCHEMA_VERSION,
  fileSystemPathSchema,
  logLevelSchema,
  nonEmptyStringSchema,
  positiveIntegerSchema,
  runtimeEnvironmentSchema,
  schemaVersionSchema,
} from "./common.js";

export const gatewayConfigRecordSchema = z.object({
  schemaVersion: schemaVersionSchema.default(CONTRACT_SCHEMA_VERSION),
  environment: runtimeEnvironmentSchema.default("development"),
  publicHost: nonEmptyStringSchema.default("127.0.0.1"),
  publicPort: z.number().int().positive().default(1337),
  controlHost: nonEmptyStringSchema.default("127.0.0.1"),
  controlPort: z.number().int().positive().default(16384),
  enableLan: z.boolean().default(false),
  corsAllowlist: z.array(nonEmptyStringSchema).default(["http://127.0.0.1"]),
  authRequired: z.boolean().default(false),
  publicAuthToken: nonEmptyStringSchema.optional(),
  logLevel: logLevelSchema.default("info"),
  defaultModelTtlMs: positiveIntegerSchema.default(900000),
  maxActiveModelsInMemory: positiveIntegerSchema.default(0),
  requestTraceRetentionDays: z.number().int().positive().default(30),
  localModelsDir: fileSystemPathSchema.default(path.join(os.homedir(), ".llm_hub", "models")),
});

export const desktopConfigRecordSchema = z.object({
  schemaVersion: schemaVersionSchema.default(CONTRACT_SCHEMA_VERSION),
  environment: runtimeEnvironmentSchema.default("development"),
  closeToTray: z.boolean().default(true),
  autoLaunchGateway: z.boolean().default(true),
  theme: z.enum(["system", "light", "dark"]).default("system"),
  controlAuthHeaderName: z.enum(["authorization", "x-api-key", "api-key"]).default("authorization"),
  controlAuthToken: nonEmptyStringSchema.optional(),
  preferredWindowWidth: z.number().int().positive().default(1440),
  preferredWindowHeight: z.number().int().positive().default(960),
  logLevel: logLevelSchema.default("info"),
});

export const apiTokenRecordSchema = z.object({
  id: nonEmptyStringSchema,
  label: nonEmptyStringSchema,
  tokenHash: nonEmptyStringSchema,
  scopes: z.array(nonEmptyStringSchema).default(["public"]),
  createdAt: z.string().datetime({ offset: true }),
  lastUsedAt: z.string().datetime({ offset: true }).optional(),
  revokedAt: z.string().datetime({ offset: true }).optional(),
});

export const promptCacheRecordSchema = z.object({
  id: nonEmptyStringSchema,
  modelId: nonEmptyStringSchema,
  cacheKey: nonEmptyStringSchema,
  filePath: fileSystemPathSchema,
  sizeBytes: z.number().int().nonnegative(),
  lastAccessedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }).optional(),
});

export const gatewayDiscoveryFileSchema = z.object({
  schemaVersion: schemaVersionSchema.default(CONTRACT_SCHEMA_VERSION),
  environment: runtimeEnvironmentSchema,
  gatewayVersion: nonEmptyStringSchema,
  generatedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }).optional(),
  publicBaseUrl: z.string().url(),
  controlBaseUrl: z.string().url(),
  websocketUrl: z.string().url(),
  pid: positiveIntegerSchema.optional(),
  supportRoot: fileSystemPathSchema,
});

export const gatewayConfigDefaults = gatewayConfigRecordSchema.parse({});
export const desktopConfigDefaults = desktopConfigRecordSchema.parse({});

export type GatewayConfigRecord = z.infer<typeof gatewayConfigRecordSchema>;
export type DesktopConfigRecord = z.infer<typeof desktopConfigRecordSchema>;
export type ControlAuthHeaderName = DesktopConfigRecord["controlAuthHeaderName"];
export type GatewayDiscoveryFile = z.infer<typeof gatewayDiscoveryFileSchema>;
export type ApiTokenRecord = z.infer<typeof apiTokenRecordSchema>;
export type PromptCacheRecord = z.infer<typeof promptCacheRecordSchema>;
