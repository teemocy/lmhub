import { z } from "zod";

import {
  isoDatetimeSchema,
  jsonRecordSchema,
  nonEmptyStringSchema,
  positiveIntegerSchema,
  traceIdSchema,
} from "./common.js";
import { runtimeKeySchema } from "./runtime.js";

export const requestRouteSchema = z.enum([
  "GET /healthz",
  "GET /v1/models",
  "GET /control/health",
  "GET /control/models",
  "POST /v1/chat/completions",
  "POST /v1/embeddings",
  "POST /control/models/preload",
  "POST /control/models/evict",
  "POST /control/models/register-local",
  "POST /control/system/shutdown",
  "GET /control/downloads",
  "POST /control/downloads",
  "GET /control/engines",
  "POST /control/engines",
  "PUT /config/gateway",
  "PUT /config/models/:id",
]);

export const requestTraceSchema = z.object({
  traceId: traceIdSchema,
  requestId: nonEmptyStringSchema,
  route: requestRouteSchema,
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  modelId: nonEmptyStringSchema.optional(),
  runtimeKey: runtimeKeySchema.optional(),
  remoteAddress: nonEmptyStringSchema.optional(),
  receivedAt: isoDatetimeSchema,
  completedAt: isoDatetimeSchema.optional(),
  durationMs: positiveIntegerSchema.optional(),
  ttftMs: positiveIntegerSchema.optional(),
  promptTokens: positiveIntegerSchema.optional(),
  completionTokens: positiveIntegerSchema.optional(),
  statusCode: positiveIntegerSchema.optional(),
  metadata: jsonRecordSchema.default({}),
});

export type RequestRoute = z.infer<typeof requestRouteSchema>;
export type RequestTrace = z.infer<typeof requestTraceSchema>;
