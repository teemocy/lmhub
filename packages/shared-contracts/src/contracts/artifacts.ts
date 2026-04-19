import type { FlashAttentionType, PoolingMethod } from "../models.js";
import type { CapabilitySet } from "./capabilities.js";
import type { EngineFamily } from "./engine.js";
import type { ProviderId } from "./providers.js";

export const MODEL_ARTIFACT_FORMATS = ["gguf", "mlx"] as const;

export type ModelArtifactFormat = (typeof MODEL_ARTIFACT_FORMATS)[number];

export const MODEL_ARTIFACT_STATES = [
  "discovered",
  "registered",
  "ready",
  "downloading",
  "corrupted",
  "deleted",
] as const;

export type ModelArtifactState = (typeof MODEL_ARTIFACT_STATES)[number];

export const HASH_ALGORITHMS = ["sha256", "sha1", "md5"] as const;

export type HashAlgorithm = (typeof HASH_ALGORITHMS)[number];

export interface ArtifactChecksum {
  algorithm: HashAlgorithm;
  value: string;
  source: "provider" | "user" | "computed";
  status: "none" | "unknown" | "pending" | "verified" | "mismatch";
  verifiedAt?: string;
}

export const GGUF_VALUE_TYPES = ["string", "number", "boolean", "string[]", "number[]"] as const;

export type GgufValueType = (typeof GGUF_VALUE_TYPES)[number];

export type GgufMetadataValue = string | number | boolean | string[] | number[];

export interface GgufMetadataEntry {
  key: string;
  valueType: GgufValueType;
  value: GgufMetadataValue;
}

export interface GgufHeaderInfo {
  format: "gguf";
  version: number;
  tensorCount: number;
  metadataEntryCount: number;
  alignmentBytes?: number;
}

export interface GgufArchitectureMetadata {
  architecture?: string;
  quantization?: string;
  parameterCount?: number;
  contextLength?: number;
  embeddingLength?: number;
  blockCount?: number;
  headCount?: number;
  headCountKv?: number;
  expertCount?: number;
  tokenizerModel?: string;
  chatTemplate?: string;
  ropeTheta?: number;
}

export interface GgufMetadata {
  header: GgufHeaderInfo;
  architecture: GgufArchitectureMetadata;
  kv: GgufMetadataEntry[];
  source: "sniffed" | "fixture" | "provider";
  warnings: string[];
}

export interface ModelArtifact {
  id: string;
  provider: ProviderId | "local";
  providerModelId?: string;
  sourceUri: string;
  fileName: string;
  format: ModelArtifactFormat;
  mediaType: "application/octet-stream" | "application/gguf";
  sizeBytes: number;
  localPath: string;
  checksum?: ArtifactChecksum;
  gguf?: GgufMetadata;
  tags: string[];
  state: ModelArtifactState;
  createdAt: string;
  updatedAt: string;
}

export interface ModelParameterOverrides {
  contextLength?: number;
  batchSize?: number;
  ubatchSize?: number;
  gpuLayers?: number;
  parallelSlots?: number;
  flashAttentionType?: FlashAttentionType;
  poolingMethod?: PoolingMethod;
  tensorSplit?: number[];
  temperature?: number;
  topP?: number;
  topK?: number;
  repeatPenalty?: number;
  ttlMs?: number;
  seed?: number;
}

export interface ModelProfile {
  id: string;
  artifactId: string;
  displayName: string;
  engineFamily: EngineFamily;
  capabilities: CapabilitySet;
  defaults: ModelParameterOverrides;
  overrides?: ModelParameterOverrides;
  labels: string[];
}

export interface RuntimeFacingModelMetadata {
  artifactId: string;
  profileId: string;
  displayName: string;
  engineFamily: EngineFamily;
  provider: ProviderId | "local";
  format: ModelArtifactFormat;
  sizeBytes: number;
  state: ModelArtifactState;
  localPath: string;
  quantization?: string;
  architecture?: string;
  contextLength?: number;
  embeddingLength?: number;
  checksumStatus: ArtifactChecksum["status"];
  capabilities: CapabilitySet;
}
