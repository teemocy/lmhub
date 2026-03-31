import { z } from "zod";

import {
  isoDatetimeSchema,
  nonEmptyStringSchema,
  positiveIntegerSchema,
  traceIdSchema,
} from "./common.js";
import { requestTraceSchema } from "./request-tracing.js";
import { runtimeKeySchema, workerLifecycleStateSchema } from "./runtime.js";

export const gatewayEventTypeSchema = z.enum([
  "MODEL_STATE_CHANGED",
  "LOG_STREAM",
  "METRICS_TICK",
  "REQUEST_TRACE",
  "DOWNLOAD_PROGRESS",
]);

export const modelStateChangedPayloadSchema = z.object({
  modelId: nonEmptyStringSchema,
  runtimeKey: runtimeKeySchema,
  previousState: workerLifecycleStateSchema.optional(),
  nextState: workerLifecycleStateSchema,
  reason: nonEmptyStringSchema.optional(),
});

export const logStreamPayloadSchema = z.object({
  runtimeKey: runtimeKeySchema,
  level: z.enum(["debug", "info", "warn", "error"]),
  message: nonEmptyStringSchema,
  source: z.enum(["gateway", "worker", "desktop", "system"]),
});

export const metricsTickPayloadSchema = z.object({
  activeWorkers: positiveIntegerSchema,
  queuedRequests: positiveIntegerSchema,
  residentMemoryBytes: z.number().int().nonnegative(),
  gpuMemoryBytes: z.number().int().nonnegative().optional(),
});

export const downloadProgressPayloadSchema = z.object({
  taskId: nonEmptyStringSchema,
  modelId: nonEmptyStringSchema.optional(),
  downloadedBytes: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative().optional(),
  rateBytesPerSecond: z.number().nonnegative().optional(),
  status: z.enum(["pending", "downloading", "paused", "completed", "error"]),
  message: nonEmptyStringSchema.optional(),
});

export const modelStateChangedEventSchema = z.object({
  type: z.literal("MODEL_STATE_CHANGED"),
  ts: isoDatetimeSchema,
  traceId: traceIdSchema,
  payload: modelStateChangedPayloadSchema,
});

export const logStreamEventSchema = z.object({
  type: z.literal("LOG_STREAM"),
  ts: isoDatetimeSchema,
  traceId: traceIdSchema,
  payload: logStreamPayloadSchema,
});

export const metricsTickEventSchema = z.object({
  type: z.literal("METRICS_TICK"),
  ts: isoDatetimeSchema,
  traceId: traceIdSchema,
  payload: metricsTickPayloadSchema,
});

export const requestTraceEventSchema = z.object({
  type: z.literal("REQUEST_TRACE"),
  ts: isoDatetimeSchema,
  traceId: traceIdSchema,
  payload: requestTraceSchema,
});

export const downloadProgressEventSchema = z.object({
  type: z.literal("DOWNLOAD_PROGRESS"),
  ts: isoDatetimeSchema,
  traceId: traceIdSchema,
  payload: downloadProgressPayloadSchema,
});

export const gatewayEventSchema = z.discriminatedUnion("type", [
  modelStateChangedEventSchema,
  logStreamEventSchema,
  metricsTickEventSchema,
  requestTraceEventSchema,
  downloadProgressEventSchema,
]);

export type GatewayEvent = z.infer<typeof gatewayEventSchema>;
export type GatewayEventType = z.infer<typeof gatewayEventTypeSchema>;
