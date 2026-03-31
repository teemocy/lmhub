import { z } from "zod";

import { isoDatetimeSchema } from "./common.js";
import { type GatewayDiscoveryFile, gatewayDiscoveryFileSchema } from "./config.js";

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
export type DesktopShellPhase = z.infer<typeof desktopShellPhaseSchema>;
export type DesktopShellState = z.infer<typeof desktopShellStateSchema>;
