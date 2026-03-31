import type { EngineFamily } from "./engine.js";

export const RUNTIME_CAPABILITY_FLAGS = [
  "chat",
  "embeddings",
  "toolCalls",
  "vision",
  "audioTranscription",
  "audioSpeech",
  "rerank",
  "promptCache",
  "streaming",
] as const;

export type RuntimeCapabilityFlag = (typeof RUNTIME_CAPABILITY_FLAGS)[number];

export const EXECUTION_CAPABILITY_FLAGS = [
  "cpu",
  "metal",
  "cuda",
  "vulkan",
  "gpuOffload",
  "multiGpu",
  "mmap",
  "mlock",
] as const;

export type ExecutionCapabilityFlag = (typeof EXECUTION_CAPABILITY_FLAGS)[number];

export interface CapabilityLimits {
  maxContextTokens?: number;
  maxBatchTokens?: number;
  maxEmbeddingDimensions?: number;
  maxGpuLayers?: number;
}

export interface CapabilityMetadata {
  engineFamily: EngineFamily;
  transport: "openai-compatible" | "llama.cpp-server";
  experimentalFlags: string[];
}

export interface CapabilitySet {
  runtime: Record<RuntimeCapabilityFlag, boolean>;
  execution: Record<ExecutionCapabilityFlag, boolean>;
  limits: CapabilityLimits;
  metadata: CapabilityMetadata;
}
