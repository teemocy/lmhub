import { createHash } from "node:crypto";
import path from "node:path";

import type { EngineVersionsRepository, ModelsRepository } from "@localhub/db";
import type {
  EngineVersionRecord,
} from "@localhub/shared-contracts/foundation-persistence";
import type { CapabilitySet, ModelArtifact, ModelProfile, RuntimeRole } from "@localhub/shared-contracts/foundation-models";
import type { RuntimeKey } from "@localhub/shared-contracts/foundation-runtime";

import type { EngineAdapter, EngineInstallResult } from "@localhub/engine-core";

import { launchLlamaCppSession, type LiveLlamaCppSession } from "./session.js";
import { toArtifactMetadata, verifyGgufFile, type GgufVerificationResult } from "./gguf.js";

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

export interface LlamaCppModelManagerOptions {
  supportRoot: string;
  adapter: EngineAdapter;
  modelsRepository: ModelsRepository;
  engineVersionsRepository?: EngineVersionsRepository;
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
  return baseName
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function deriveCapabilities(
  filePath: string,
  metadata: GgufVerificationResult["metadata"],
): CapabilitySet {
  const lowerHint = `${metadata.modelName ?? ""} ${path.basename(filePath)}`.toLowerCase();
  const looksEmbeddingOnly =
    /\b(embed|embedding|bge|e5)\b/.test(lowerHint) &&
    !metadata.chatTemplate &&
    !/\b(chat|instruct|coder|assistant)\b/.test(lowerHint);
  const hasChatTemplate = Boolean(metadata.chatTemplate);

  return {
    chat: !looksEmbeddingOnly,
    embeddings: looksEmbeddingOnly || metadata.embeddingLength !== undefined,
    tools: hasChatTemplate || /\b(chat|instruct|coder|tool)\b/.test(lowerHint),
    streaming: true,
    vision: false,
    audioTranscription: false,
    audioSpeech: false,
    rerank: /\brerank\b/.test(lowerHint),
    promptCache: !looksEmbeddingOnly,
  };
}

function deriveRole(capabilities: CapabilitySet): RuntimeRole {
  if (capabilities.embeddings && !capabilities.chat) {
    return "embeddings";
  }

  if (capabilities.rerank) {
    return "rerank";
  }

  return "chat";
}

function createRuntimeKey(profile: ModelProfile): RuntimeKey {
  const configHash = createHash("sha1")
    .update(JSON.stringify(profile.parameterOverrides))
    .digest("hex")
    .slice(0, 12);

  return {
    modelId: profile.modelId,
    engineType: profile.engineType,
    role: profile.role,
    configHash,
  };
}

function toIndexedRecord(
  artifact: ModelArtifact,
  profile: ModelProfile | undefined,
  loadCount: number,
  lastLoadedAt: string | undefined,
): IndexedModelRecord {
  const capabilities = artifact.capabilities;
  const role = profile?.role ?? deriveRole(capabilities);

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
  readonly #adapter: EngineAdapter;
  readonly #modelsRepository: ModelsRepository;
  readonly #engineVersionsRepository: EngineVersionsRepository | undefined;
  readonly #now: () => string;

  constructor(options: LlamaCppModelManagerOptions) {
    this.#supportRoot = options.supportRoot;
    this.#adapter = options.adapter;
    this.#modelsRepository = options.modelsRepository;
    this.#engineVersionsRepository = options.engineVersionsRepository;
    this.#now = options.now ?? (() => new Date().toISOString());
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
    const capabilities = deriveCapabilities(filePath, verification.metadata);
    const role = deriveRole(capabilities);
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
        kind: "local",
        checksumSha256: verification.checksumSha256,
      },
      metadata: toArtifactMetadata(verification.metadata),
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
      ...(options.promptCacheKey ?? existing?.profile?.promptCacheKey
        ? {
            promptCacheKey:
              options.promptCacheKey ?? existing?.profile?.promptCacheKey ?? undefined,
          }
        : {}),
      role,
      parameterOverrides:
        options.parameterOverrides ??
        existing?.profile?.parameterOverrides ??
        {
          ...(verification.metadata.contextLength !== undefined
            ? { contextLength: verification.metadata.contextLength }
            : {}),
        },
      createdAt: existing?.profile?.createdAt ?? now,
      updatedAt: now,
    };

    this.#modelsRepository.save(artifact, profile);

    return {
      artifact,
      profile,
      checksumSha256: verification.checksumSha256,
      indexed: toIndexedRecord(
        artifact,
        profile,
        existing?.loadCount ?? 0,
        existing?.lastLoadedAt,
      ),
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

  async ensureEngineVersion(versionTag = "stage2-default"): Promise<EngineInstallResult> {
    const installResult = await this.#adapter.install(versionTag);
    const record = toEngineVersionRecord(installResult, this.#now());
    if (record && this.#engineVersionsRepository) {
      this.#engineVersionsRepository.upsert(record);
      if (record.isActive) {
        this.#engineVersionsRepository.setActive(record.engineType, record.id);
      }
    }

    return installResult;
  }

  async launchRegisteredModel(
    options: LaunchRegisteredModelOptions,
  ): Promise<LiveLlamaCppSession> {
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
    }

    return session;
  }
}
