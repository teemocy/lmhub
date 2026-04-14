import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import path from "node:path";

import type { EngineVersionsRepository, ModelsRepository } from "@localhub/db";
import type {
  CapabilitySet,
  ModelArtifact,
  ModelProfile,
  RuntimeRole,
} from "@localhub/shared-contracts/foundation-models";
import type { EngineVersionRecord } from "@localhub/shared-contracts/foundation-persistence";

import type { EngineAdapter, EngineInstallResult } from "@localhub/engine-core";

const MLX_ENGINE_TYPE = "mlx";

export interface IndexedModelRecord {
  artifactId: string;
  profileId?: string;
  displayName: string;
  localPath: string;
  engineType: string;
  role: RuntimeRole;
  sizeBytes: number;
  format: ModelArtifact["format"];
  architecture?: string;
  quantization?: string;
  contextLength?: number;
  parameterCount?: number;
  checksumSha256?: string;
  capabilities: CapabilitySet;
  loadCount: number;
  lastLoadedAt?: string;
  updatedAt: string;
}

export interface RegisterLocalModelOptions {
  filePath: string;
  displayName?: string;
  artifactId?: string;
  profileId?: string;
  tags?: string[];
  pinned?: boolean;
  expectedChecksumSha256?: string;
  sourceKind?: ModelArtifact["source"]["kind"];
  remoteUrl?: string;
  revision?: string;
  parameterOverrides?: ModelProfile["parameterOverrides"];
}

export interface RegisteredLocalModel {
  artifact: ModelArtifact;
  profile: ModelProfile;
  checksumSha256: string;
  indexed: IndexedModelRecord;
  metadata: {
    architecture?: string;
    contextLength?: number;
    parameterCount?: number;
    tokenizer?: string;
    quantization?: string;
    shardCount: number;
  };
}

export interface MlxModelManagerOptions {
  supportRoot: string;
  localModelsDir: string;
  adapter: EngineAdapter;
  modelsRepository: ModelsRepository;
  engineVersionsRepository?: EngineVersionsRepository;
  now?: () => string;
}

interface InspectedMlxDirectory {
  rootPath: string;
  displayName: string;
  sizeBytes: number;
  checksumSha256: string;
  architecture?: string;
  contextLength?: number;
  parameterCount?: number;
  tokenizer?: string;
  quantization?: string;
  shardCount: number;
}

function toSlug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function createDeterministicId(prefix: string, base: string, checksum: string): string {
  const slug = toSlug(base) || prefix;
  return `${prefix}_${slug}_${checksum.slice(0, 12)}`;
}

function humanizeDirectoryName(filePath: string): string {
  return path.basename(filePath).replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function isTokenizerAsset(fileName: string): boolean {
  return (
    /^tokenizer(?:\.|$)/i.test(fileName) ||
    /^special_tokens_map\.json$/i.test(fileName) ||
    /^tokenizer_config\.json$/i.test(fileName) ||
    /^vocab\.json$/i.test(fileName) ||
    /^merges\.txt$/i.test(fileName) ||
    /\.tiktoken$/i.test(fileName)
  );
}

function isTokenizerCoreAsset(fileName: string): boolean {
  return /^tokenizer(?:\.|$)/i.test(fileName) || /\.tiktoken$/i.test(fileName);
}

function hasRequiredTokenizerAssets(fileNames: Iterable<string>): boolean {
  let hasTokenizerCoreAsset = false;
  let hasVocabJson = false;
  let hasMergesTxt = false;

  for (const fileName of fileNames) {
    if (isTokenizerCoreAsset(fileName)) {
      hasTokenizerCoreAsset = true;
    }
    if (/^vocab\.json$/i.test(fileName)) {
      hasVocabJson = true;
    }
    if (/^merges\.txt$/i.test(fileName)) {
      hasMergesTxt = true;
    }
  }

  return hasTokenizerCoreAsset || (hasVocabJson && hasMergesTxt);
}

function isSafetensorShard(fileName: string): boolean {
  return /\.safetensors(?:\.index\.json)?$/i.test(fileName);
}

function isLikelyMlxDirectory(directory: string): boolean {
  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return false;
  }

  const fileNames = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
  const shardCount = [...fileNames].filter((fileName) => isSafetensorShard(fileName)).length;
  return hasRequiredTokenizerAssets(fileNames) && shardCount > 0;
}

export function isMlxModelDirectoryPath(filePath: string): boolean {
  try {
    return statSync(filePath).isDirectory() && isLikelyMlxDirectory(filePath);
  } catch {
    return false;
  }
}

function collectCandidateModelDirectories(rootDir: string): string[] {
  const candidates: string[] = [];

  const visit = (directory: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }

    if (isLikelyMlxDirectory(directory)) {
      candidates.push(directory);
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      visit(path.join(directory, entry.name));
    }
  };

  visit(rootDir);
  return candidates.sort((left, right) => left.localeCompare(right));
}

function readJsonRecord(filePath: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function getOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function getOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function getArchitecture(config: Record<string, unknown>): string | undefined {
  const modelType = getOptionalString(config.model_type);
  if (modelType) {
    return modelType;
  }

  const architectures = config.architectures;
  if (Array.isArray(architectures)) {
    return architectures.find(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
  }

  return undefined;
}

function getContextLength(config: Record<string, unknown>): number | undefined {
  return (
    getOptionalNumber(config.max_position_embeddings) ??
    getOptionalNumber(config.max_sequence_length) ??
    getOptionalNumber(config.max_seq_len) ??
    getOptionalNumber(config.n_ctx) ??
    getOptionalNumber(
      config.text_config &&
        typeof config.text_config === "object" &&
        !Array.isArray(config.text_config)
        ? (config.text_config as Record<string, unknown>).max_position_embeddings
        : undefined,
    )
  );
}

function getParameterCount(config: Record<string, unknown>): number | undefined {
  return (
    getOptionalNumber(config.num_parameters) ??
    getOptionalNumber(config.parameter_count) ??
    getOptionalNumber(
      config.text_config &&
        typeof config.text_config === "object" &&
        !Array.isArray(config.text_config)
        ? (config.text_config as Record<string, unknown>).num_parameters
        : undefined,
    )
  );
}

function getTokenizer(entries: readonly string[]): string | undefined {
  return entries.find((entry) => isTokenizerAsset(entry));
}

function getQuantization(directory: string): string | undefined {
  const quantStrategyPath = path.join(directory, "quant_strategy.json");
  if (!existsSync(quantStrategyPath)) {
    return undefined;
  }

  const parsed = readJsonRecord(quantStrategyPath);
  return getOptionalString(parsed.group_size)
    ? `group-${parsed.group_size}`
    : getOptionalString(parsed.bits)
      ? `${parsed.bits}-bit`
      : "quantized";
}

function inspectDirectory(directory: string): InspectedMlxDirectory {
  const entries = readdirSync(directory, { withFileTypes: true });
  const fileEntries = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  const shardCount = fileEntries.filter((entry) => isSafetensorShard(entry)).length;
  const config = readJsonRecord(path.join(directory, "config.json"));
  const architecture = getArchitecture(config);
  const contextLength = getContextLength(config);
  const parameterCount = getParameterCount(config);
  const tokenizer = getTokenizer(fileEntries);
  const quantization = getQuantization(directory);

  let sizeBytes = 0;
  const hash = createHash("sha256");
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const filePath = path.join(directory, entry.name);
    const stats = statSync(filePath);
    sizeBytes += stats.size;
    hash.update(entry.name);
    hash.update(String(stats.size));
    hash.update(String(stats.mtimeMs));
  }

  return {
    rootPath: directory,
    displayName:
      getOptionalString(config._name_or_path) ??
      getOptionalString(config.name) ??
      humanizeDirectoryName(directory),
    sizeBytes,
    checksumSha256: hash.digest("hex"),
    ...(architecture ? { architecture } : {}),
    ...(contextLength ? { contextLength } : {}),
    ...(parameterCount ? { parameterCount } : {}),
    ...(tokenizer ? { tokenizer } : {}),
    ...(quantization ? { quantization } : {}),
    shardCount,
  };
}

function normalizeCapabilityOverrides(
  overrides: ModelProfile["capabilityOverrides"],
): NonNullable<ModelProfile["capabilityOverrides"]> {
  if (!overrides) {
    return {};
  }

  const normalized: NonNullable<ModelProfile["capabilityOverrides"]> = {};
  for (const key of [
    "chat",
    "embeddings",
    "vision",
    "audioTranscription",
    "audioSpeech",
    "rerank",
    "tools",
    "streaming",
  ] as const) {
    const value = overrides[key];
    if (typeof value === "boolean") {
      normalized[key] = value;
    }
  }

  return normalized;
}

function applyCapabilityOverrides(
  capabilities: CapabilitySet,
  overrides: ModelProfile["capabilityOverrides"],
): CapabilitySet {
  const normalizedOverrides = normalizeCapabilityOverrides(overrides);
  return {
    chat: normalizedOverrides.chat ?? capabilities.chat,
    embeddings: normalizedOverrides.embeddings ?? capabilities.embeddings,
    tools: normalizedOverrides.tools ?? capabilities.tools,
    streaming: normalizedOverrides.streaming ?? capabilities.streaming,
    vision: normalizedOverrides.vision ?? capabilities.vision,
    audioTranscription: normalizedOverrides.audioTranscription ?? capabilities.audioTranscription,
    audioSpeech: normalizedOverrides.audioSpeech ?? capabilities.audioSpeech,
    rerank: normalizedOverrides.rerank ?? capabilities.rerank,
    promptCache: false,
  };
}

function deriveCapabilities(): CapabilitySet {
  return {
    chat: true,
    embeddings: false,
    tools: true,
    streaming: true,
    vision: false,
    audioTranscription: false,
    audioSpeech: false,
    rerank: false,
    promptCache: false,
  };
}

function deriveRole(capabilities: CapabilitySet): RuntimeRole {
  if (capabilities.rerank) {
    return "rerank";
  }

  if (capabilities.embeddings && !capabilities.chat) {
    return "embeddings";
  }

  return "chat";
}

function toIndexedRecord(
  artifact: ModelArtifact,
  profile: ModelProfile | undefined,
  loadCount: number,
  lastLoadedAt: string | undefined,
): IndexedModelRecord {
  const capabilities = applyCapabilityOverrides(
    artifact.capabilities,
    profile?.capabilityOverrides,
  );
  const role = profile?.role ?? deriveRole(capabilities);
  const record: IndexedModelRecord = {
    artifactId: artifact.id,
    displayName: profile?.displayName ?? artifact.name,
    localPath: artifact.localPath,
    engineType: profile?.engineType ?? MLX_ENGINE_TYPE,
    role,
    sizeBytes: artifact.sizeBytes,
    format: artifact.format,
    capabilities,
    loadCount,
    updatedAt: artifact.updatedAt,
  };

  if (profile) {
    record.profileId = profile.id;
  }
  if (artifact.architecture) {
    record.architecture = artifact.architecture;
  }
  if (artifact.quantization) {
    record.quantization = artifact.quantization;
  }
  if (artifact.metadata.contextLength !== undefined) {
    record.contextLength = artifact.metadata.contextLength;
  }
  if (artifact.metadata.parameterCount !== undefined) {
    record.parameterCount = artifact.metadata.parameterCount;
  }
  if (artifact.source.checksumSha256) {
    record.checksumSha256 = artifact.source.checksumSha256;
  }
  if (lastLoadedAt) {
    record.lastLoadedAt = lastLoadedAt;
  }

  return record;
}

function toEngineVersionRecord(
  installResult: EngineInstallResult,
  now: string,
): EngineVersionRecord | undefined {
  if (!installResult.binaryPath) {
    return undefined;
  }

  return {
    id: `engine_mlx_${toSlug(installResult.versionTag)}`,
    engineType: MLX_ENGINE_TYPE,
    versionTag: installResult.versionTag,
    binaryPath: installResult.binaryPath,
    isActive: installResult.activated,
    capabilities: {
      chat: true,
      streaming: true,
    },
    compatibilityNotes: installResult.notes.join(" "),
    installedAt: now,
  };
}

export class MlxModelManager {
  readonly #supportRoot: string;
  readonly #localModelsDir: string;
  readonly #adapter: EngineAdapter;
  readonly #modelsRepository: ModelsRepository;
  readonly #engineVersionsRepository: EngineVersionsRepository | undefined;
  readonly #now: () => string;

  constructor(options: MlxModelManagerOptions) {
    this.#supportRoot = options.supportRoot;
    this.#localModelsDir = options.localModelsDir;
    this.#adapter = options.adapter;
    this.#modelsRepository = options.modelsRepository;
    this.#engineVersionsRepository = options.engineVersionsRepository;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  isModelDirectory(filePath: string): boolean {
    return isMlxModelDirectoryPath(path.resolve(filePath));
  }

  async scanLocalModels(): Promise<RegisteredLocalModel[]> {
    mkdirSync(this.#localModelsDir, { recursive: true });

    const existingPaths = new Set(
      this.#modelsRepository
        .list()
        .filter((record) => record.profile?.engineType === MLX_ENGINE_TYPE)
        .map((record) => path.resolve(record.artifact.localPath)),
    );
    const registered: RegisteredLocalModel[] = [];

    for (const directory of collectCandidateModelDirectories(this.#localModelsDir)) {
      const normalizedPath = path.resolve(directory);
      if (existingPaths.has(normalizedPath)) {
        continue;
      }

      try {
        const result = await this.registerLocalModel({ filePath: normalizedPath });
        registered.push(result);
        existingPaths.add(normalizedPath);
      } catch {
        // Ignore unreadable directories while auto-discovering local MLX models.
      }
    }

    return registered;
  }

  async registerLocalModel(options: RegisterLocalModelOptions): Promise<RegisteredLocalModel> {
    const directoryPath = path.resolve(options.filePath);
    if (!isMlxModelDirectoryPath(directoryPath)) {
      throw new Error(`Expected an MLX model directory, received ${directoryPath}.`);
    }

    const existing = this.#modelsRepository
      .list()
      .find((record) => path.resolve(record.artifact.localPath) === directoryPath);
    const inspected = inspectDirectory(directoryPath);
    const now = this.#now();
    const displayName =
      options.displayName ?? existing?.profile?.displayName ?? inspected.displayName;
    const capabilities = deriveCapabilities();
    const capabilityOverrides = normalizeCapabilityOverrides(
      existing?.profile?.capabilityOverrides,
    );
    const effectiveCapabilities = applyCapabilityOverrides(capabilities, capabilityOverrides);
    const role = deriveRole(effectiveCapabilities);
    const artifactId =
      existing?.artifact.id ??
      options.artifactId ??
      createDeterministicId("model", inspected.displayName, inspected.checksumSha256);

    const artifact: ModelArtifact = {
      schemaVersion: 1,
      id: artifactId,
      name: inspected.displayName,
      localPath: directoryPath,
      format: "mlx",
      sizeBytes: inspected.sizeBytes,
      ...(inspected.architecture ? { architecture: inspected.architecture } : {}),
      ...(inspected.quantization ? { quantization: inspected.quantization } : {}),
      createdAt: existing?.artifact.createdAt ?? now,
      updatedAt: now,
      source: {
        kind: options.sourceKind ?? existing?.artifact.source.kind ?? "local",
        ...((options.remoteUrl ?? existing?.artifact.source.remoteUrl)
          ? {
              remoteUrl: options.remoteUrl ?? existing?.artifact.source.remoteUrl ?? undefined,
            }
          : {}),
        ...((options.revision ?? existing?.artifact.source.revision)
          ? {
              revision: options.revision ?? existing?.artifact.source.revision ?? undefined,
            }
          : {}),
        checksumSha256: inspected.checksumSha256,
      },
      metadata: {
        schemaVersion: 1,
        ...(inspected.architecture ? { architecture: inspected.architecture } : {}),
        ...(inspected.quantization ? { quantization: inspected.quantization } : {}),
        ...(inspected.contextLength ? { contextLength: inspected.contextLength } : {}),
        ...(inspected.parameterCount ? { parameterCount: inspected.parameterCount } : {}),
        ...(inspected.tokenizer ? { tokenizer: inspected.tokenizer } : {}),
        metadata: {
          shardCount: inspected.shardCount,
        },
      },
      capabilities,
      tags: options.tags ?? existing?.artifact.tags ?? [],
    };

    const profile: ModelProfile = {
      schemaVersion: 1,
      id:
        existing?.profile?.id ??
        options.profileId ??
        createDeterministicId("profile", displayName, inspected.checksumSha256),
      modelId: artifact.id,
      displayName,
      engineType: MLX_ENGINE_TYPE,
      pinned: options.pinned ?? existing?.profile?.pinned ?? false,
      defaultTtlMs: existing?.profile?.defaultTtlMs ?? 900_000,
      role,
      parameterOverrides: options.parameterOverrides ?? existing?.profile?.parameterOverrides ?? {},
      capabilityOverrides,
      createdAt: existing?.profile?.createdAt ?? now,
      updatedAt: now,
    };

    this.#modelsRepository.save(artifact, profile);

    return {
      artifact,
      profile,
      checksumSha256: inspected.checksumSha256,
      indexed: toIndexedRecord(artifact, profile, existing?.loadCount ?? 0, existing?.lastLoadedAt),
      metadata: {
        ...(inspected.architecture ? { architecture: inspected.architecture } : {}),
        ...(inspected.contextLength ? { contextLength: inspected.contextLength } : {}),
        ...(inspected.parameterCount ? { parameterCount: inspected.parameterCount } : {}),
        ...(inspected.tokenizer ? { tokenizer: inspected.tokenizer } : {}),
        ...(inspected.quantization ? { quantization: inspected.quantization } : {}),
        shardCount: inspected.shardCount,
      },
    };
  }

  async ensureEngineVersion(versionTag?: string): Promise<EngineInstallResult> {
    const installResult = await this.#adapter.install(versionTag ?? "");
    const record = toEngineVersionRecord(installResult, this.#now());
    if (record && this.#engineVersionsRepository) {
      const storedId = this.#engineVersionsRepository.upsert(record);
      if (record.isActive) {
        this.#engineVersionsRepository.setActive(record.engineType, storedId);
      }
    }

    return installResult;
  }

  async installManagedRuntime(options: { versionTag?: string } = {}): Promise<EngineInstallResult> {
    return await this.ensureEngineVersion(options.versionTag);
  }

  async activateEngineVersion(versionTag: string): Promise<EngineInstallResult> {
    const activation = await this.#adapter.activate(versionTag, this.#supportRoot);
    const installResult: EngineInstallResult = {
      success: activation.success,
      versionTag: activation.versionTag,
      registryFile: activation.registryFile,
      activated: activation.success,
      ...(activation.binaryPath ? { binaryPath: activation.binaryPath } : {}),
      notes: activation.notes,
    };
    const record = toEngineVersionRecord(installResult, this.#now());
    if (record && this.#engineVersionsRepository) {
      const storedId = this.#engineVersionsRepository.upsert(record);
      this.#engineVersionsRepository.setActive(record.engineType, storedId);
    }

    return installResult;
  }
}
