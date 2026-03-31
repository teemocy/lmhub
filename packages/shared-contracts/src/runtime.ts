import { z } from "zod";

import {
  isoDatetimeSchema,
  nonEmptyStringSchema,
  positiveIntegerSchema,
  traceIdSchema,
} from "./common.js";
import { runtimeRoleSchema } from "./models.js";

export const workerLifecycleStateSchema = z.enum([
  "Loading",
  "Ready",
  "Busy",
  "Unloading",
  "Crashed",
  "CoolingDown",
]);

export const runtimeKeySchema = z.object({
  modelId: nonEmptyStringSchema,
  engineType: nonEmptyStringSchema,
  role: runtimeRoleSchema,
  configHash: nonEmptyStringSchema,
});

export const runtimeKeyStringSchema = z
  .string()
  .min(8)
  .regex(/^[A-Za-z0-9:_-]+$/);

export const workerStateSchema = z.object({
  runtimeKey: runtimeKeySchema,
  runtimeKeyString: runtimeKeyStringSchema,
  state: workerLifecycleStateSchema,
  modelId: nonEmptyStringSchema,
  traceId: traceIdSchema.optional(),
  pid: positiveIntegerSchema.optional(),
  startedAt: isoDatetimeSchema.optional(),
  updatedAt: isoDatetimeSchema,
  lastError: nonEmptyStringSchema.optional(),
});

export const gatewayHealthSnapshotSchema = z.object({
  state: z.enum(["starting", "ready", "degraded", "stopping"]),
  publicBaseUrl: z.string().url(),
  controlBaseUrl: z.string().url(),
  uptimeMs: positiveIntegerSchema,
  activeWorkers: positiveIntegerSchema,
  queuedRequests: positiveIntegerSchema,
  generatedAt: isoDatetimeSchema,
});

export type RuntimeKey = z.infer<typeof runtimeKeySchema>;
export type WorkerLifecycleState = z.infer<typeof workerLifecycleStateSchema>;
export type WorkerState = z.infer<typeof workerStateSchema>;
export type GatewayHealthSnapshot = z.infer<typeof gatewayHealthSnapshotSchema>;
