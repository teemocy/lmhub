import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import type { Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  EngineVersionsRepository,
  ModelsRepository,
  PromptCachesRepository,
} from "@localhub/db";
import type { PromptCacheRecord } from "@localhub/shared-contracts/foundation-config";
import type {
  CapabilitySet,
  ModelArtifact,
  ModelProfile,
  RuntimeRole,
} from "@localhub/shared-contracts/foundation-models";
import type { EngineVersionRecord } from "@localhub/shared-contracts/foundation-persistence";
import type { RuntimeKey } from "@localhub/shared-contracts/foundation-runtime";

import type { EngineAdapter, EngineInstallResult } from "@localhub/engine-core";

import {
  downloadPrebuiltMetalLlamaCppBinary,
  importLocalLlamaCppBinary,
} from "./binary-installer.js";
import { type GgufVerificationResult, toArtifactMetadata, verifyGgufFile } from "./gguf.js";
import { type LiveLlamaCppSession, launchLlamaCppSession } from "./session.js";

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
  promptCacheKey?: string;
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
  metadata: GgufVerificationResult["metadata"];
}

export interface LaunchRegisteredModelOptions {
  artifactId: string;
  host?: string;
  port?: number;
  versionTag?: string;
}

export interface LoadResourceEstimate {
  modelId: string;
  estimatedModelBytes: number;
  estimatedContextBytes: number;
  estimatedWorkingSetBytes: number;
  systemMemoryBytes: number;
  availableMemoryBytes: number;
  risk: "low" | "medium" | "high";
  warnings: string[];
}

export interface PromptCacheLifecycleSummary {
  touched: PromptCacheRecord[];
  removedCacheKeys: string[];
}

export interface RepairSummary {
  reinstalledEngineVersions: string[];
  reactivatedEngineVersions: string[];
  missingModelArtifacts: string[];
  removedPromptCacheKeys: string[];
  notes: string[];
}

export interface LlamaCppModelManagerOptions {
  supportRoot: string;
  localModelsDir: string;
  adapter: EngineAdapter;
  modelsRepository: ModelsRepository;
  engineVersionsRepository?: EngineVersionsRepository;
  promptCachesRepository?: PromptCachesRepository;
  now?: () => string;
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

function humanizeFileName(filePath: string): string {
  const baseName = path.basename(filePath, path.extname(filePath));
  return baseName.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function hasVisionChatTemplate(chatTemplate: string | undefined): boolean {
  return (
    typeof chatTemplate === "string" &&
    /<\|vision_start\|>|<\|image_pad\|>|<\|video_pad\|>/i.test(chatTemplate)
  );
}

function findMmprojCompanionPath(filePath: string): string | undefined {
  const fileName = path.basename(filePath);
  if (/^mmproj(?:[-_.]|$)/i.test(fileName)) {
    return undefined;
  }

  try {
    const baseStem = path.basename(filePath, path.extname(filePath)).toLowerCase();
    const baseTokens = new Set(
      baseStem.split(/[^a-z0-9]+/).filter((token) => token.length >= 3),
    );
    const candidates = readdirSync(path.dirname(filePath), { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^mmproj.*\.gguf$/i.test(entry.name))
      .map((entry) => path.join(path.dirname(filePath), entry.name));

    if (candidates.length === 0) {
      return undefined;
    }

    if (candidates.length === 1) {
      return candidates[0];
    }

    return (
      candidates
        .map((candidate) => {
          const candidateName = path.basename(candidate).toLowerCase();
          const score = [...baseTokens].filter((token) => candidateName.includes(token)).length;
          return {
            candidate,
            score,
          };
        })
        .sort(
          (left, right) => right.score - left.score || left.candidate.localeCompare(right.candidate),
        )[0]?.candidate
    );
  } catch {
    return undefined;
  }
}

function deriveCapabilities(
  filePath: string,
  metadata: GgufVerificationResult["metadata"],
  mmprojPath = findMmprojCompanionPath(filePath),
): CapabilitySet {
  const lowerHint = `${metadata.modelName ?? ""} ${path.basename(filePath)}`.toLowerCase();
  const looksEmbeddingOnly = /\b(embed|embedding|bge|e5)\b/.test(lowerHint);
  const looksReranker = /\brerank(?:er)?\b/.test(lowerHint);
  const hasChatTemplate = Boolean(metadata.chatTemplate);
  const isProjectorArtifact =
    metadata.architecture?.toLowerCase() === "clip" || /\bmmproj\b/.test(lowerHint);
  const supportsVision =
    !isProjectorArtifact && (hasVisionChatTemplate(metadata.chatTemplate) || Boolean(mmprojPath));
  const supportsEmbeddings =
    !isProjectorArtifact &&
    !looksReranker &&
    (looksEmbeddingOnly || (metadata.embeddingLength !== undefined && !hasChatTemplate));
  const supportsChat = !isProjectorArtifact && !looksEmbeddingOnly && !looksReranker;

  return {
    chat: supportsChat,
    embeddings: supportsEmbeddings,
    tools:
      supportsChat && (hasChatTemplate || /\b(chat|instruct|coder|tool)\b/.test(lowerHint)),
    streaming: true,
    vision: supportsVision,
    audioTranscription: false,
    audioSpeech: false,
    rerank: looksReranker,
    promptCache: supportsChat,
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

function normalizeCapabilityOverrides(
  overrides: ModelProfile["capabilityOverrides"],
): NonNullable<ModelProfile["capabilityOverrides"]> {
  if (!overrides) {
    return {};
  }

  const normalized: NonNullable<ModelProfile["capabilityOverrides"]> = {};
  const orderedKeys: Array<Exclude<keyof CapabilitySet, "promptCache">> = [
    "chat",
    "embeddings",
    "vision",
    "audioTranscription",
    "audioSpeech",
    "rerank",
    "tools",
    "streaming",
  ];

  for (const key of orderedKeys) {
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
    audioTranscription:
      normalizedOverrides.audioTranscription ?? capabilities.audioTranscription,
    audioSpeech: normalizedOverrides.audioSpeech ?? capabilities.audioSpeech,
    rerank: normalizedOverrides.rerank ?? capabilities.rerank,
    promptCache: true,
  };
}

function getEffectiveCapabilities(
  artifact: ModelArtifact,
  profile: ModelProfile | undefined,
): CapabilitySet {
  return applyCapabilityOverrides(artifact.capabilities, profile?.capabilityOverrides);
}

function getRoleForProfile(
  artifact: ModelArtifact,
  profile: ModelProfile | undefined,
): RuntimeRole {
  const capabilities = getEffectiveCapabilities(artifact, profile);
  const normalizedOverrides = normalizeCapabilityOverrides(profile?.capabilityOverrides);

  if (Object.keys(normalizedOverrides).length > 0) {
    return deriveRole(capabilities);
  }

  return profile?.role ?? deriveRole(capabilities);
}

function toRegisteredArtifactMetadata(
  filePath: string,
  metadata: GgufVerificationResult["metadata"],
  mmprojPath = findMmprojCompanionPath(filePath),
): ModelArtifact["metadata"] {
  const artifactMetadata = toArtifactMetadata(metadata);

  if (!mmprojPath) {
    return artifactMetadata;
  }

  return {
    ...artifactMetadata,
    metadata: {
      ...artifactMetadata.metadata,
      mmprojPath,
    },
  };
}

function getContextLength(artifact: ModelArtifact, profile: ModelProfile): number {
  const overrideValue = profile.parameterOverrides.contextLength;
  if (typeof overrideValue === "number" && Number.isFinite(overrideValue) && overrideValue > 0) {
    return Math.floor(overrideValue);
  }

  if (
    typeof artifact.metadata.contextLength === "number" &&
    Number.isFinite(artifact.metadata.contextLength) &&
    artifact.metadata.contextLength > 0
  ) {
    return artifact.metadata.contextLength;
  }

  return 4096;
}

function createRuntimeKey(profile: ModelProfile): RuntimeKey {
  const configHash = createHash("sha1")
    .update(
      JSON.stringify({
        parameterOverrides: profile.parameterOverrides,
        capabilityOverrides: normalizeCapabilityOverrides(profile.capabilityOverrides),
      }),
    )
    .digest("hex")
    .slice(0, 12);

  return {
    modelId: profile.modelId,
    engineType: profile.engineType,
    role: profile.role,
    configHash,
  };
}

function collectCandidateModelPaths(rootDir: string): string[] {
  const candidates: string[] = [];

  const visit = (directory: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }

      if (
        entry.isFile() &&
        entry.name.toLowerCase().endsWith(".gguf") &&
        !/^mmproj(?:[-_.]|$)/i.test(entry.name)
      ) {
        candidates.push(fullPath);
      }
    }
  };

  visit(rootDir);
  return candidates.sort((left, right) => left.localeCompare(right));
}

function toIndexedRecord(
  artifact: ModelArtifact,
  profile: ModelProfile | undefined,
  loadCount: number,
  lastLoadedAt: string | undefined,
): IndexedModelRecord {
  const capabilities = getEffectiveCapabilities(artifact, profile);
  const role = getRoleForProfile(artifact, profile);

  const record: IndexedModelRecord = {
    artifactId: artifact.id,
    displayName: profile?.displayName ?? artifact.name,
    localPath: artifact.localPath,
    engineType: profile?.engineType ?? "llama.cpp",
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
  if (!installResult.binaryPath || installResult.binaryPath === process.execPath) {
    return undefined;
  }

  return {
    id: `engine_llamacpp_${toSlug(installResult.versionTag)}`,
    engineType: "llama.cpp",
    versionTag: installResult.versionTag,
    binaryPath: installResult.binaryPath,
    isActive: installResult.activated,
    capabilities: {
      chat: true,
      embeddings: true,
      streaming: true,
    },
    compatibilityNotes: installResult.notes.join(" "),
    installedAt: now,
  };
}

export class LlamaCppModelManager {
  readonly #supportRoot: string;
  readonly #localModelsDir: string;
  readonly #adapter: EngineAdapter;
  readonly #modelsRepository: ModelsRepository;
  readonly #engineVersionsRepository: EngineVersionsRepository | undefined;
  readonly #promptCachesRepository: PromptCachesRepository | undefined;
  readonly #now: () => string;

  constructor(options: LlamaCppModelManagerOptions) {
    this.#supportRoot = options.supportRoot;
    this.#localModelsDir = options.localModelsDir;
    this.#adapter = options.adapter;
    this.#modelsRepository = options.modelsRepository;
    this.#engineVersionsRepository = options.engineVersionsRepository;
    this.#promptCachesRepository = options.promptCachesRepository;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async scanLocalModels(): Promise<RegisteredLocalModel[]> {
    mkdirSync(this.#localModelsDir, { recursive: true });

    const existingPaths = new Set(
      this.#modelsRepository.list().map((record) => path.resolve(record.artifact.localPath)),
    );
    const registered: RegisteredLocalModel[] = [];

    for (const filePath of collectCandidateModelPaths(this.#localModelsDir)) {
      const normalizedPath = path.resolve(filePath);
      if (existingPaths.has(normalizedPath)) {
        continue;
      }

      try {
        const result = await this.registerLocalModel({ filePath: normalizedPath });
        registered.push(result);
        existingPaths.add(normalizedPath);
      } catch {
        // Ignore unreadable or invalid GGUF files while auto-discovering local models.
      }
    }

    return registered;
  }

  async registerLocalModel(options: RegisterLocalModelOptions): Promise<RegisteredLocalModel> {
    const filePath = path.resolve(options.filePath);
    const existing = this.#modelsRepository
      .list()
      .find((record) => path.resolve(record.artifact.localPath) === filePath);
    const now = this.#now();
    const verification = await verifyGgufFile(filePath, options.expectedChecksumSha256);
    const displayName =
      options.displayName ??
      existing?.profile?.displayName ??
      verification.metadata.modelName ??
      humanizeFileName(filePath);
    const artifactName = verification.metadata.modelName ?? existing?.artifact.name ?? displayName;
    const mmprojPath = findMmprojCompanionPath(filePath);
    const capabilities = deriveCapabilities(filePath, verification.metadata, mmprojPath);
    const capabilityOverrides = normalizeCapabilityOverrides(existing?.profile?.capabilityOverrides);
    const effectiveCapabilities = applyCapabilityOverrides(capabilities, capabilityOverrides);
    const role = deriveRole(effectiveCapabilities);
    const artifactId =
      existing?.artifact.id ??
      options.artifactId ??
      createDeterministicId("model", artifactName, verification.checksumSha256);

    const artifact: ModelArtifact = {
      schemaVersion: 1,
      id: artifactId,
      name: artifactName,
      localPath: filePath,
      format: "gguf",
      sizeBytes: verification.sizeBytes,
      ...(verification.metadata.architecture
        ? { architecture: verification.metadata.architecture }
        : {}),
      ...(verification.metadata.quantization
        ? { quantization: verification.metadata.quantization }
        : {}),
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
        checksumSha256: verification.checksumSha256,
      },
      metadata: toRegisteredArtifactMetadata(filePath, verification.metadata, mmprojPath),
      capabilities,
      tags: options.tags ?? existing?.artifact.tags ?? [],
    };

    const profile: ModelProfile = {
      schemaVersion: 1,
      id:
        existing?.profile?.id ??
        options.profileId ??
        createDeterministicId("profile", displayName, verification.checksumSha256),
      modelId: artifact.id,
      displayName,
      engineType: "llama.cpp",
      pinned: options.pinned ?? existing?.profile?.pinned ?? false,
      defaultTtlMs: existing?.profile?.defaultTtlMs ?? 900_000,
      ...((options.promptCacheKey ?? existing?.profile?.promptCacheKey)
        ? {
            promptCacheKey:
              options.promptCacheKey ?? existing?.profile?.promptCacheKey ?? undefined,
          }
        : {}),
      role,
      parameterOverrides: options.parameterOverrides ??
        existing?.profile?.parameterOverrides ?? {
          ...(verification.metadata.contextLength !== undefined
            ? { contextLength: verification.metadata.contextLength }
            : {}),
        },
      capabilityOverrides,
      createdAt: existing?.profile?.createdAt ?? now,
      updatedAt: now,
    };

    this.#modelsRepository.save(artifact, profile);

    return {
      artifact,
      profile,
      checksumSha256: verification.checksumSha256,
      indexed: toIndexedRecord(artifact, profile, existing?.loadCount ?? 0, existing?.lastLoadedAt),
      metadata: verification.metadata,
    };
  }

  listIndexedModels(): IndexedModelRecord[] {
    return this.#modelsRepository
      .list()
      .map((record) =>
        toIndexedRecord(record.artifact, record.profile, record.loadCount, record.lastLoadedAt),
      );
  }

  findIndexedModel(artifactId: string): IndexedModelRecord | undefined {
    const record = this.#modelsRepository.findById(artifactId);
    if (!record) {
      return undefined;
    }

    return toIndexedRecord(record.artifact, record.profile, record.loadCount, record.lastLoadedAt);
  }

  listEngineVersions(): EngineVersionRecord[] {
    return this.#engineVersionsRepository?.list() ?? [];
  }

  async ensureEngineVersion(versionTag = "stage2-default"): Promise<EngineInstallResult> {
    const installResult = await this.#adapter.install(versionTag);
    const record = toEngineVersionRecord(installResult, this.#now());
    if (record && this.#engineVersionsRepository) {
      const storedId = this.#engineVersionsRepository.upsert(record);
      if (record.isActive) {
        this.#engineVersionsRepository.setActive(record.engineType, storedId);
      }
    }

    return installResult;
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

  async downloadPackagedMetalBinary(options: {
    releaseTag?: string;
    versionTag?: string;
    fetch?: typeof fetch;
  } = {}): Promise<EngineInstallResult> {
    const installResult = await downloadPrebuiltMetalLlamaCppBinary({
      supportRoot: this.#supportRoot,
      ...(options.releaseTag ? { releaseTag: options.releaseTag } : {}),
      ...(options.versionTag ? { versionTag: options.versionTag } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });

    if (this.#engineVersionsRepository) {
      const record = toEngineVersionRecord(installResult, this.#now());
      if (record) {
        const storedId = this.#engineVersionsRepository.upsert(record);
        if (record.isActive) {
          this.#engineVersionsRepository.setActive(record.engineType, storedId);
        }
      }
    }

    return installResult;
  }

  async importLocalEngineBinary(options: {
    sourcePath: string;
    versionTag?: string;
  }): Promise<EngineInstallResult> {
    const installResult = await importLocalLlamaCppBinary({
      supportRoot: this.#supportRoot,
      sourcePath: options.sourcePath,
      ...(options.versionTag ? { versionTag: options.versionTag } : {}),
    });

    if (this.#engineVersionsRepository) {
      const record = toEngineVersionRecord(installResult, this.#now());
      if (record) {
        const storedId = this.#engineVersionsRepository.upsert(record);
        if (record.isActive) {
          this.#engineVersionsRepository.setActive(record.engineType, storedId);
        }
      }
    }

    return installResult;
  }

  estimateLoadResources(artifactId: string): LoadResourceEstimate {
    const storedRecord = this.#modelsRepository.findById(artifactId);
    if (!storedRecord || !storedRecord.profile) {
      throw new Error(`Unknown registered model: ${artifactId}`);
    }

    const contextLength = getContextLength(storedRecord.artifact, storedRecord.profile);
    const estimatedModelBytes = storedRecord.artifact.sizeBytes;
    const estimatedContextBytes = contextLength * 4096;
    const estimatedWorkingSetBytes = Math.round(estimatedModelBytes * 1.18 + estimatedContextBytes);
    const systemMemoryBytes = os.totalmem();
    const availableMemoryBytes = Math.max(0, systemMemoryBytes - process.memoryUsage().rss);
    const warnings: string[] = [];
    let risk: LoadResourceEstimate["risk"] = "low";

    if (estimatedWorkingSetBytes > availableMemoryBytes) {
      risk = "high";
      warnings.push("Estimated working set exceeds currently available system memory.");
    } else if (estimatedWorkingSetBytes > availableMemoryBytes * 0.75) {
      risk = "medium";
      warnings.push("Estimated working set is close to currently available system memory.");
    }

    if (contextLength >= 32768) {
      warnings.push("Large context lengths increase KV cache memory pressure.");
      if (risk === "low") {
        risk = "medium";
      }
    }

    return {
      modelId: storedRecord.artifact.id,
      estimatedModelBytes,
      estimatedContextBytes,
      estimatedWorkingSetBytes,
      systemMemoryBytes,
      availableMemoryBytes,
      risk,
      warnings,
    };
  }

  recordPromptCacheAccess(
    artifactId: string,
    accessedAt = this.#now(),
  ): PromptCacheRecord | undefined {
    if (!this.#promptCachesRepository) {
      return undefined;
    }

    const storedRecord = this.#modelsRepository.findById(artifactId);
    if (!storedRecord?.profile?.promptCacheKey) {
      return undefined;
    }

    const filePath = path.join(
      this.#supportRoot,
      "prompt-caches",
      `${storedRecord.profile.promptCacheKey}.bin`,
    );
    const sizeBytes = existsSync(filePath) ? statSync(filePath).size : 0;
    const expiresAt =
      storedRecord.profile.defaultTtlMs > 0
        ? new Date(new Date(accessedAt).getTime() + storedRecord.profile.defaultTtlMs).toISOString()
        : undefined;
    const record: PromptCacheRecord = {
      id: `cache_${storedRecord.profile.promptCacheKey}`,
      modelId: storedRecord.artifact.id,
      cacheKey: storedRecord.profile.promptCacheKey,
      filePath,
      sizeBytes,
      lastAccessedAt: accessedAt,
      ...(expiresAt ? { expiresAt } : {}),
    };

    this.#promptCachesRepository.upsert(record, {
      runtime: "llama.cpp",
      modelDisplayName: storedRecord.profile.displayName,
    });

    return record;
  }

  cleanupPromptCaches(now = this.#now()): PromptCacheLifecycleSummary {
    if (!this.#promptCachesRepository) {
      return {
        touched: [],
        removedCacheKeys: [],
      };
    }

    const touched = this.#promptCachesRepository.list().map((entry) => ({
      id: entry.id,
      modelId: entry.modelId,
      cacheKey: entry.cacheKey,
      filePath: entry.filePath,
      sizeBytes: entry.sizeBytes,
      lastAccessedAt: entry.lastAccessedAt,
      ...(entry.expiresAt ? { expiresAt: entry.expiresAt } : {}),
    }));
    const removedCacheKeys: string[] = [];

    for (const cache of touched) {
      const expired = cache.expiresAt ? cache.expiresAt <= now : false;
      const missing = !existsSync(cache.filePath);
      if (!expired && !missing) {
        continue;
      }

      if (existsSync(cache.filePath)) {
        unlinkSync(cache.filePath);
      }
      this.#promptCachesRepository.removeByCacheKey(cache.cacheKey);
      removedCacheKeys.push(cache.cacheKey);
    }

    return {
      touched,
      removedCacheKeys,
    };
  }

  async repairIntegrity(): Promise<RepairSummary> {
    const reinstalledEngineVersions: string[] = [];
    const reactivatedEngineVersions: string[] = [];
    const missingModelArtifacts: string[] = [];
    const notes: string[] = [];

    if (this.#engineVersionsRepository) {
      for (const record of this.#engineVersionsRepository.list()) {
        if (!existsSync(record.binaryPath)) {
          try {
            await this.ensureEngineVersion(record.versionTag);
            reinstalledEngineVersions.push(record.versionTag);
            notes.push(`Reinstalled engine version ${record.versionTag}.`);
          } catch (error) {
            notes.push(
              error instanceof Error
                ? `Unable to restore engine version ${record.versionTag}: ${error.message}`
                : `Unable to restore engine version ${record.versionTag}.`,
            );
          }
        }
      }

      const activeEngine = this.#engineVersionsRepository.findActive("llama.cpp");
      if (activeEngine && !existsSync(activeEngine.binaryPath)) {
        try {
          const repaired = await this.activateEngineVersion(activeEngine.versionTag);
          if (repaired.activated) {
            reactivatedEngineVersions.push(activeEngine.versionTag);
          }
        } catch (error) {
          notes.push(
            error instanceof Error
              ? `Unable to reactivate engine version ${activeEngine.versionTag}: ${error.message}`
              : `Unable to reactivate engine version ${activeEngine.versionTag}.`,
          );
        }
      }
    }

    for (const record of this.#modelsRepository.list()) {
      if (!existsSync(record.artifact.localPath)) {
        missingModelArtifacts.push(record.artifact.id);
        notes.push(`Model artifact ${record.artifact.id} is missing at ${record.artifact.localPath}.`);
      }
    }

    const promptCacheCleanup = this.cleanupPromptCaches();
    if (promptCacheCleanup.removedCacheKeys.length > 0) {
      notes.push(`Removed ${promptCacheCleanup.removedCacheKeys.length} stale prompt cache entries.`);
    }

    return {
      reinstalledEngineVersions,
      reactivatedEngineVersions,
      missingModelArtifacts,
      removedPromptCacheKeys: promptCacheCleanup.removedCacheKeys,
      notes,
    };
  }

  async launchRegisteredModel(options: LaunchRegisteredModelOptions): Promise<LiveLlamaCppSession> {
    const storedRecord = this.#modelsRepository.findById(options.artifactId);
    if (!storedRecord || !storedRecord.profile) {
      throw new Error(`Unknown registered model: ${options.artifactId}`);
    }

    const installResult = await this.ensureEngineVersion(options.versionTag);
    const runtimeKey = createRuntimeKey(storedRecord.profile);
    const session = await launchLlamaCppSession(this.#adapter, {
      artifact: storedRecord.artifact,
      profile: storedRecord.profile,
      runtimeKey,
      supportRoot: this.#supportRoot,
      ...(options.host ? { host: options.host } : {}),
      ...(options.port !== undefined ? { port: options.port } : {}),
      ...(installResult.versionTag ? { versionTag: installResult.versionTag } : {}),
    });

    const readyHealth = await session.waitForReady();
    if (readyHealth.ok) {
      this.#modelsRepository.markLoaded(storedRecord.artifact.id, this.#now());
      this.recordPromptCacheAccess(storedRecord.artifact.id, this.#now());
    }

    return session;
  }
}
