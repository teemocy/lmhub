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

const MAX_REASONABLE_CONTEXT_LENGTH = 10_000_000;
const MAX_REASONABLE_PARAMETER_COUNT = 10_000_000_000_000;
const GENERIC_TOKENIZER_CLASS_PATTERN = /^(?:AutoTokenizer|PreTrainedTokenizer(?:Fast)?)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonRecord(filePath: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function getOptionalNumber(
  value: unknown,
  options: { integer?: boolean; max?: number; min?: number } = {},
): number | undefined {
  const { integer = false, max, min = 0 } = options;
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim().length > 0
        ? Number(value.trim())
        : undefined;

  if (parsed === undefined || !Number.isFinite(parsed)) {
    return undefined;
  }

  const normalized = integer ? Math.floor(parsed) : parsed;
  if (normalized <= min) {
    return undefined;
  }
  if (max !== undefined && normalized > max) {
    return undefined;
  }

  return normalized;
}

function getOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function getNestedRecord(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function normalizeArchitectureLabel(value: string): string {
  return value
    .replace(
      /(For(?:CausalLM|ConditionalGeneration|QuestionAnswering|SequenceClassification|TokenClassification|MaskedLM|SpeechSeq2Seq|VisionTextDualEncoder|ImageTextToText)|Model)$/u,
      "",
    )
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function getModelConfigRecords(config: Record<string, unknown>): Record<string, unknown>[] {
  const records = [config];
  const textConfig = getNestedRecord(config, "text_config");
  if (textConfig) {
    records.push(textConfig);
  }

  return records;
}

function pickFirstInteger(
  records: readonly Record<string, unknown>[],
  keys: readonly string[],
  max: number,
): number | undefined {
  for (const record of records) {
    for (const key of keys) {
      const value = getOptionalNumber(record[key], { integer: true, max });
      if (value !== undefined) {
        return value;
      }
    }
  }

  return undefined;
}

function getArchitecture(config: Record<string, unknown>): string | undefined {
  for (const record of getModelConfigRecords(config)) {
    const modelType = getOptionalString(record.model_type);
    if (modelType) {
      return normalizeArchitectureLabel(modelType);
    }
  }

  for (const record of getModelConfigRecords(config)) {
    const architectures = record.architectures;
    if (Array.isArray(architectures)) {
      const architecture = architectures.find(
        (value): value is string => typeof value === "string" && value.length > 0,
      );
      if (architecture) {
        return normalizeArchitectureLabel(architecture);
      }
    }
  }

  return undefined;
}

function getContextLength(
  config: Record<string, unknown>,
  generationConfig: Record<string, unknown>,
  tokenizerConfig: Record<string, unknown>,
): number | undefined {
  const records = [...getModelConfigRecords(config), generationConfig, tokenizerConfig].filter(
    (record) => Object.keys(record).length > 0,
  );
  const directValue = pickFirstInteger(
    records,
    [
      "max_position_embeddings",
      "max_sequence_length",
      "max_seq_len",
      "n_ctx",
      "seq_length",
      "sequence_length",
      "model_max_length",
      "max_length",
    ],
    MAX_REASONABLE_CONTEXT_LENGTH,
  );
  if (directValue !== undefined) {
    return directValue;
  }

  for (const record of records) {
    const ropeScaling = getNestedRecord(record, "rope_scaling");
    if (!ropeScaling) {
      continue;
    }

    const originalMaxPositionEmbeddings = getOptionalNumber(
      ropeScaling.original_max_position_embeddings,
      {
        integer: true,
        max: MAX_REASONABLE_CONTEXT_LENGTH,
      },
    );
    if (originalMaxPositionEmbeddings !== undefined) {
      return originalMaxPositionEmbeddings;
    }
  }

  return undefined;
}

function roundParameterCount(value: number): number {
  return Math.round(value / 1_000_000) * 1_000_000;
}

function getParameterCountFromName(...texts: Array<string | undefined>): number | undefined {
  let bestMatch: number | undefined;

  for (const text of texts) {
    if (!text) {
      continue;
    }

    for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*[xX]\s*(\d+(?:\.\d+)?)\s*B\b/g)) {
      const value = Number(match[1]) * Number(match[2]) * 1_000_000_000;
      if (!Number.isFinite(value)) {
        continue;
      }
      bestMatch = bestMatch === undefined ? value : Math.max(bestMatch, value);
    }

    for (const match of text.matchAll(/(\d+(?:\.\d+)?)\s*(T|B|M)\b/gi)) {
      const scalar = Number(match[1]);
      if (!Number.isFinite(scalar)) {
        continue;
      }

      const unit = match[2]?.toUpperCase();
      const multiplier =
        unit === "T" ? 1_000_000_000_000 : unit === "B" ? 1_000_000_000 : 1_000_000;
      const value = scalar * multiplier;
      bestMatch = bestMatch === undefined ? value : Math.max(bestMatch, value);
    }
  }

  return bestMatch !== undefined ? roundParameterCount(bestMatch) : undefined;
}

function inferUsesGatedMlp(architecture: string | undefined): boolean {
  if (!architecture) {
    return false;
  }

  return [
    "llama",
    "mistral",
    "mixtral",
    "gemma",
    "qwen",
    "qwen2",
    "qwen3",
    "phi3",
    "deepseek",
    "cohere",
    "internlm",
  ].some((prefix) => architecture.startsWith(prefix));
}

function estimateDenseTransformerParameterCount(
  config: Record<string, unknown>,
  architecture: string | undefined,
): number | undefined {
  const modelConfig = getNestedRecord(config, "text_config") ?? config;
  const expertCount =
    getOptionalNumber(modelConfig.num_local_experts, { integer: true }) ??
    getOptionalNumber(modelConfig.num_experts, { integer: true }) ??
    getOptionalNumber(modelConfig.n_routed_experts, { integer: true });
  if (expertCount !== undefined && expertCount > 1) {
    return undefined;
  }

  const hiddenSize =
    getOptionalNumber(modelConfig.hidden_size, { integer: true }) ??
    getOptionalNumber(modelConfig.d_model, { integer: true }) ??
    getOptionalNumber(modelConfig.n_embd, { integer: true });
  const layerCount =
    getOptionalNumber(modelConfig.num_hidden_layers, { integer: true }) ??
    getOptionalNumber(modelConfig.num_layers, { integer: true }) ??
    getOptionalNumber(modelConfig.n_layer, { integer: true });
  const vocabSize = getOptionalNumber(modelConfig.vocab_size, { integer: true });
  const intermediateSize =
    getOptionalNumber(modelConfig.intermediate_size, { integer: true }) ??
    getOptionalNumber(modelConfig.ffn_hidden_size, { integer: true }) ??
    getOptionalNumber(modelConfig.ffn_dim, { integer: true }) ??
    getOptionalNumber(modelConfig.n_inner, { integer: true });
  const attentionHeadCount =
    getOptionalNumber(modelConfig.num_attention_heads, { integer: true }) ??
    getOptionalNumber(modelConfig.n_head, { integer: true });

  if (
    hiddenSize === undefined ||
    layerCount === undefined ||
    vocabSize === undefined ||
    intermediateSize === undefined ||
    attentionHeadCount === undefined
  ) {
    return undefined;
  }

  const keyValueHeadCount =
    getOptionalNumber(modelConfig.num_key_value_heads, { integer: true }) ??
    getOptionalNumber(modelConfig.num_kv_heads, { integer: true }) ??
    getOptionalNumber(modelConfig.n_head_kv, { integer: true }) ??
    attentionHeadCount;
  const headDimension =
    getOptionalNumber(modelConfig.head_dim, { integer: true }) ??
    (hiddenSize % attentionHeadCount === 0 ? hiddenSize / attentionHeadCount : undefined);
  if (headDimension === undefined) {
    return undefined;
  }

  const queryProjection = hiddenSize * hiddenSize;
  const keyValueProjectionWidth = headDimension * keyValueHeadCount;
  const keyProjection = hiddenSize * keyValueProjectionWidth;
  const valueProjection = hiddenSize * keyValueProjectionWidth;
  const outputProjection = hiddenSize * hiddenSize;
  const attentionParameters = queryProjection + keyProjection + valueProjection + outputProjection;
  const mlpProjectionCount = inferUsesGatedMlp(architecture) ? 3 : 2;
  const mlpParameters = hiddenSize * intermediateSize * mlpProjectionCount;
  const layerNormParameters = hiddenSize * 2;
  const tieWordEmbeddings = modelConfig.tie_word_embeddings === true;

  let embeddingParameters = vocabSize * hiddenSize * (tieWordEmbeddings ? 1 : 2);
  if (architecture && /^(?:gpt2|gptj|bert|roberta|distilbert)/.test(architecture)) {
    const positionEmbeddingCount = getOptionalNumber(modelConfig.max_position_embeddings, {
      integer: true,
      max: MAX_REASONABLE_CONTEXT_LENGTH,
    });
    if (positionEmbeddingCount !== undefined) {
      embeddingParameters += positionEmbeddingCount * hiddenSize;
    }
  }

  const total =
    layerCount * (attentionParameters + mlpParameters + layerNormParameters) +
    embeddingParameters +
    hiddenSize;
  if (!Number.isFinite(total) || total <= 0 || total > MAX_REASONABLE_PARAMETER_COUNT) {
    return undefined;
  }

  return roundParameterCount(total);
}

function getParameterCount(
  config: Record<string, unknown>,
  directory: string,
  displayName: string,
  architecture: string | undefined,
): number | undefined {
  const explicitValue = pickFirstInteger(
    getModelConfigRecords(config),
    ["num_parameters", "parameter_count", "num_params"],
    MAX_REASONABLE_PARAMETER_COUNT,
  );
  if (explicitValue !== undefined) {
    return explicitValue;
  }

  const nameBasedValue = getParameterCountFromName(
    displayName,
    getOptionalString(config._name_or_path),
    getOptionalString(config.name),
    path.basename(directory),
  );
  if (nameBasedValue !== undefined) {
    return nameBasedValue;
  }

  return estimateDenseTransformerParameterCount(config, architecture);
}

function getTokenizer(directory: string, entries: readonly string[]): string | undefined {
  const tokenizerConfig = readJsonRecord(path.join(directory, "tokenizer_config.json"));
  const tokenizerClass = getOptionalString(tokenizerConfig.tokenizer_class);
  if (tokenizerClass && !GENERIC_TOKENIZER_CLASS_PATTERN.test(tokenizerClass)) {
    return tokenizerClass;
  }

  const tokenizerJson = readJsonRecord(path.join(directory, "tokenizer.json"));
  const tokenizerModel = getNestedRecord(tokenizerJson, "model");
  const tokenizerType = tokenizerModel ? getOptionalString(tokenizerModel.type) : undefined;
  if (tokenizerType) {
    return tokenizerType.toLowerCase();
  }

  if (tokenizerClass) {
    return tokenizerClass;
  }
  if (entries.some((entry) => /\.tiktoken$/i.test(entry))) {
    return "tiktoken";
  }
  if (entries.some((entry) => /^tokenizer\.model$/i.test(entry))) {
    return "sentencepiece";
  }

  return undefined;
}

function getQuantizationFromName(...texts: Array<string | undefined>): string | undefined {
  for (const text of texts) {
    if (!text) {
      continue;
    }

    const bitMatch = /(\d+)\s*bit\b/i.exec(text);
    if (bitMatch?.[1]) {
      return `${bitMatch[1]}-bit`;
    }

    const dtypeMatch = /\b(bf16|fp16|f16|fp32|f32|int4|int8)\b/i.exec(text);
    if (dtypeMatch?.[1]) {
      const token = dtypeMatch[1].toUpperCase();
      if (token === "F16") {
        return "FP16";
      }
      if (token === "F32") {
        return "FP32";
      }
      if (token === "INT4") {
        return "4-bit";
      }
      if (token === "INT8") {
        return "8-bit";
      }

      return token;
    }
  }

  return undefined;
}

function getQuantization(directory: string, config: Record<string, unknown>): string | undefined {
  const quantStrategyPath = path.join(directory, "quant_strategy.json");
  if (existsSync(quantStrategyPath)) {
    const parsed = readJsonRecord(quantStrategyPath);
    const bits = getOptionalNumber(parsed.bits, { integer: true });
    const groupSize = getOptionalNumber(parsed.group_size, { integer: true });
    if (bits !== undefined && groupSize !== undefined) {
      return `${bits}-bit-g${groupSize}`;
    }
    if (bits !== undefined) {
      return `${bits}-bit`;
    }
    return "quantized";
  }

  const modelConfig = getNestedRecord(config, "text_config") ?? config;
  const torchDtype = getOptionalString(modelConfig.torch_dtype);
  if (torchDtype) {
    const normalizedDtype = getQuantizationFromName(torchDtype);
    if (normalizedDtype) {
      return normalizedDtype;
    }
  }

  return getQuantizationFromName(
    path.basename(directory),
    getOptionalString(config._name_or_path),
    getOptionalString(config.name),
  );
}

function inspectDirectory(directory: string): InspectedMlxDirectory {
  const entries = readdirSync(directory, { withFileTypes: true });
  const fileEntries = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  const shardCount = fileEntries.filter((entry) => isSafetensorShard(entry)).length;
  const config = readJsonRecord(path.join(directory, "config.json"));
  const generationConfig = readJsonRecord(path.join(directory, "generation_config.json"));
  const tokenizerConfig = readJsonRecord(path.join(directory, "tokenizer_config.json"));
  const displayName =
    getOptionalString(config._name_or_path) ??
    getOptionalString(config.name) ??
    humanizeDirectoryName(directory);
  const architecture = getArchitecture(config);
  const contextLength = getContextLength(config, generationConfig, tokenizerConfig);
  const parameterCount = getParameterCount(config, directory, displayName, architecture);
  const tokenizer = getTokenizer(directory, fileEntries);
  const quantization = getQuantization(directory, config);

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
    displayName,
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

  async ensureEngineVersion(
    versionTag?: string,
    options: {
      force?: boolean;
    } = {},
  ): Promise<EngineInstallResult> {
    const installResult = await this.#adapter.install(versionTag ?? "", options);
    const record = toEngineVersionRecord(installResult, this.#now());
    if (record && this.#engineVersionsRepository) {
      const storedId = this.#engineVersionsRepository.upsert(record);
      if (record.isActive) {
        this.#engineVersionsRepository.setActive(record.engineType, storedId);
      }
    }

    return installResult;
  }

  async installManagedRuntime(
    options: {
      versionTag?: string;
      forceReinstall?: boolean;
    } = {},
  ): Promise<EngineInstallResult> {
    if (options.forceReinstall) {
      return await this.ensureEngineVersion(options.versionTag, { force: true });
    }

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
