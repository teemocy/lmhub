import { z } from "zod";

export const gatewayPlaneSchema = z.enum(["public", "control"]);
export const workerStateSchema = z.enum([
  "Idle",
  "Loading",
  "Ready",
  "Busy",
  "Unloading",
  "Crashed",
  "CoolingDown",
]);

export const gatewayEventTypeSchema = z.enum([
  "MODEL_STATE_CHANGED",
  "LOG_STREAM",
  "METRICS_TICK",
  "REQUEST_TRACE",
  "DOWNLOAD_PROGRESS",
]);

export const gatewayEventSchema = z.object({
  type: gatewayEventTypeSchema,
  ts: z.string(),
  traceId: z.string().optional(),
  payload: z.record(z.string(), z.unknown()),
});

export const gatewayHealthSnapshotSchema = z.object({
  status: z.literal("ok"),
  plane: gatewayPlaneSchema,
  uptimeMs: z.number().int().nonnegative(),
  loadedModelCount: z.number().int().nonnegative(),
  activeWebSocketClients: z.number().int().nonnegative(),
});

export type GatewayPlane = z.infer<typeof gatewayPlaneSchema>;
export type WorkerState = z.infer<typeof workerStateSchema>;
export type GatewayEventType = z.infer<typeof gatewayEventTypeSchema>;
export type GatewayEvent = z.infer<typeof gatewayEventSchema>;
export type GatewayHealthSnapshot = z.infer<typeof gatewayHealthSnapshotSchema>;
