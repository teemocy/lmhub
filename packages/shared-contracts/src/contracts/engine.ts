import type { ModelArtifact, ModelProfile } from "./artifacts.js";
import type { CapabilitySet } from "./capabilities.js";

export const ENGINE_FAMILIES = ["llama.cpp", "mlx"] as const;

export type EngineFamily = (typeof ENGINE_FAMILIES)[number];

export const ENGINE_HEALTH_STATUSES = ["starting", "ready", "degraded", "unavailable"] as const;

export type EngineHealthStatus = (typeof ENGINE_HEALTH_STATUSES)[number];

export type MaybePromise<T> = T | Promise<T>;

export interface InstalledEngineVersion {
  family: EngineFamily;
  version: string;
  installRoot: string;
  binaryPath: string;
  active: boolean;
  source: "bundle" | "release" | "fixture" | "manual";
  installedAt?: string;
  notes?: string[];
}

export interface EngineProbeContext {
  platform: "darwin" | "linux" | "win32";
  arch: string;
  appSupportPath: string;
  env?: Record<string, string | undefined>;
  preferredVersion?: string;
}

export interface EngineProbeResult {
  family: EngineFamily;
  supported: boolean;
  installedVersions: InstalledEngineVersion[];
  defaultVersion?: string;
  warnings: string[];
}

export interface EngineInstallRequest {
  family: EngineFamily;
  version: string;
  installRoot: string;
  source: "bundle" | "release" | "fixture" | "manual";
  activationStrategy: "none" | "activate-on-success";
  checksum?: string;
  downloadUrl?: string;
}

export interface EngineInstallResult {
  family: EngineFamily;
  version: string;
  installRoot: string;
  binaryPath: string;
  activated: boolean;
  warnings: string[];
}

export interface ReadySignalSpec {
  kind: "http" | "stdout-substring" | "port-open";
  value: string;
  timeoutMs: number;
}

export interface EngineCommandInput {
  artifact: ModelArtifact;
  profile: ModelProfile;
  workingDirectory: string;
  host: string;
  port: number;
  promptCachePath?: string;
  mmprojPath?: string;
  extraArgs?: string[];
}

export interface ResolvedEngineCommand {
  executable: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  readySignal?: ReadySignalSpec;
}

export interface EngineHealthReport {
  status: EngineHealthStatus;
  observedAt: string;
  message?: string;
  endpoint?: string;
  pid?: number;
  metrics?: {
    rssBytes?: number;
    vramBytes?: number;
    lastReadyAt?: string;
  };
}

export interface ResponseNormalizationInput {
  transport: "http" | "sse";
  traceId: string;
  modelId: string;
  receivedAt: string;
  payload: unknown;
}

export interface ResponseNormalizationResult {
  object: "chat.completion" | "chat.completion.chunk" | "embedding";
  model: string;
  created: number;
  choices?: Array<Record<string, unknown>>;
  data?: Array<Record<string, unknown>>;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  raw: unknown;
}

export interface EngineAdapter {
  readonly family: EngineFamily;
  probe(context: EngineProbeContext): MaybePromise<EngineProbeResult>;
  install(request: EngineInstallRequest): MaybePromise<EngineInstallResult>;
  resolveCommand(input: EngineCommandInput): ResolvedEngineCommand;
  healthCheck(command: ResolvedEngineCommand, timeoutMs?: number): MaybePromise<EngineHealthReport>;
  normalizeResponse(input: ResponseNormalizationInput): ResponseNormalizationResult;
  capabilities(profile: ModelProfile, artifact: ModelArtifact): CapabilitySet;
}
