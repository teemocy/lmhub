import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, readdirSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

import type { GgufMetadata, ModelArtifact } from "@localhub/shared-contracts/foundation-models";

const GGUF_MAGIC = "GGUF";
const MAX_SAFE_U64 = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_ARRAY_SAMPLE = 8;
const MAX_REASONABLE_CONTEXT_LENGTH = 10_000_000;
const MAX_REASONABLE_PARAMETER_COUNT = 10_000_000_000_000;
const GENERIC_TOKENIZER_CLASS_PATTERN = /^(?:AutoTokenizer|PreTrainedTokenizer(?:Fast)?)$/;
const GENERIC_TOKENIZER_PATTERN = /^(?:gpt2|bpe|sentencepiece|llama|unknown)$/i;
const GGUF_COMPANION_FILE_NAMES = [
  "config.json",
  "generation_config.json",
  "tokenizer_config.json",
  "tokenizer.json",
] as const;

enum GgufValueType {
  Uint8 = 0,
  Int8 = 1,
  Uint16 = 2,
  Int16 = 3,
  Uint32 = 4,
  Int32 = 5,
  Float32 = 6,
  Bool = 7,
  String = 8,
  Array = 9,
  Uint64 = 10,
  Int64 = 11,
  Float64 = 12,
}

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

interface GgufCompanionMetadata {
  files: string[];
  modelName?: string;
  architecture?: string;
  contextLength?: number;
  parameterCount?: number;
  tokenizer?: string;
}

export interface SniffedGgufMetadata {
  format: "gguf";
  version: number;
  tensorCount: number;
  metadataEntryCount: number;
  metadata: Record<string, JsonValue>;
  modelName?: string;
  architecture?: string;
  quantization?: string;
  contextLength?: number;
  parameterCount?: number;
  embeddingLength?: number;
  tokenizer?: string;
  chatTemplate?: string;
}

export interface GgufVerificationResult {
  filePath: string;
  fileName: string;
  sizeBytes: number;
  checksumSha256: string;
  matchesExpectedChecksum: boolean | undefined;
  metadata: SniffedGgufMetadata;
}

class GgufCursor {
  readonly #handle: Awaited<ReturnType<typeof open>>;
  #offset = 0;

  constructor(handle: Awaited<ReturnType<typeof open>>) {
    this.#handle = handle;
  }

  async readExactly(length: number): Promise<Buffer> {
    const buffer = Buffer.alloc(length);
    let totalRead = 0;

    while (totalRead < length) {
      const { bytesRead } = await this.#handle.read(
        buffer,
        totalRead,
        length - totalRead,
        this.#offset,
      );

      if (bytesRead === 0) {
        throw new Error(`Unexpected EOF while parsing GGUF at byte offset ${this.#offset}.`);
      }

      totalRead += bytesRead;
      this.#offset += bytesRead;
    }

    return buffer;
  }

  async readUint8(): Promise<number> {
    return (await this.readExactly(1)).readUInt8(0);
  }

  async readInt8(): Promise<number> {
    return (await this.readExactly(1)).readInt8(0);
  }

  async readUint16(): Promise<number> {
    return (await this.readExactly(2)).readUInt16LE(0);
  }

  async readInt16(): Promise<number> {
    return (await this.readExactly(2)).readInt16LE(0);
  }

  async readUint32(): Promise<number> {
    return (await this.readExactly(4)).readUInt32LE(0);
  }

  async readInt32(): Promise<number> {
    return (await this.readExactly(4)).readInt32LE(0);
  }

  async readFloat32(): Promise<number> {
    return (await this.readExactly(4)).readFloatLE(0);
  }

  async readFloat64(): Promise<number> {
    return (await this.readExactly(8)).readDoubleLE(0);
  }

  async readUint64(): Promise<bigint> {
    return (await this.readExactly(8)).readBigUInt64LE(0);
  }

  async readInt64(): Promise<bigint> {
    return (await this.readExactly(8)).readBigInt64LE(0);
  }

  async readBool(): Promise<boolean> {
    return (await this.readUint8()) !== 0;
  }

  async readString(): Promise<string> {
    const length = await this.readSafeLength("GGUF string length");
    if (length === 0) {
      return "";
    }

    return (await this.readExactly(length)).toString("utf8");
  }

  async readSafeLength(label: string): Promise<number> {
    const rawValue = await this.readUint64();
    if (rawValue > MAX_SAFE_U64) {
      throw new Error(`${label} exceeds JavaScript safe integer range.`);
    }

    return Number(rawValue);
  }
}

function toSafeNumber(value: bigint): number | undefined {
  if (value > MAX_SAFE_U64 || value < -MAX_SAFE_U64) {
    return undefined;
  }

  return Number(value);
}

async function readScalarValue(cursor: GgufCursor, valueType: GgufValueType): Promise<JsonValue> {
  switch (valueType) {
    case GgufValueType.Uint8:
      return cursor.readUint8();
    case GgufValueType.Int8:
      return cursor.readInt8();
    case GgufValueType.Uint16:
      return cursor.readUint16();
    case GgufValueType.Int16:
      return cursor.readInt16();
    case GgufValueType.Uint32:
      return cursor.readUint32();
    case GgufValueType.Int32:
      return cursor.readInt32();
    case GgufValueType.Float32:
      return cursor.readFloat32();
    case GgufValueType.Bool:
      return cursor.readBool();
    case GgufValueType.String:
      return cursor.readString();
    case GgufValueType.Uint64: {
      const value = await cursor.readUint64();
      return toSafeNumber(value) ?? value.toString();
    }
    case GgufValueType.Int64: {
      const value = await cursor.readInt64();
      return toSafeNumber(value) ?? value.toString();
    }
    case GgufValueType.Float64:
      return cursor.readFloat64();
    default:
      throw new Error(`Unsupported GGUF scalar value type: ${valueType}`);
  }
}

async function readValue(cursor: GgufCursor, valueType: GgufValueType): Promise<JsonValue> {
  if (valueType !== GgufValueType.Array) {
    return readScalarValue(cursor, valueType);
  }

  const elementType = (await cursor.readUint32()) as GgufValueType;
  const length = await cursor.readSafeLength("GGUF array length");
  const sample: JsonValue[] = [];

  for (let index = 0; index < length; index += 1) {
    const value =
      elementType === GgufValueType.Array
        ? await readValue(cursor, GgufValueType.Array)
        : await readScalarValue(cursor, elementType);

    if (index < MAX_ARRAY_SAMPLE) {
      sample.push(value);
    }
  }

  if (length <= MAX_ARRAY_SAMPLE) {
    return sample;
  }

  return {
    kind: "array",
    elementType,
    length,
    sample,
  };
}

function firstString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function firstNumber(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function getOptionalNumber(
  value: unknown,
  options: {
    integer?: boolean;
    max?: number;
  } = {},
): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  const normalized = options.integer ? Math.floor(value) : value;
  if (normalized <= 0) {
    return undefined;
  }
  if (options.max !== undefined && normalized > options.max) {
    return undefined;
  }

  return normalized;
}

function getNestedRecord(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function readJsonRecord(filePath: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
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

function getCompanionArchitecture(config: Record<string, unknown>): string | undefined {
  for (const record of getModelConfigRecords(config)) {
    const modelType = getOptionalString(record.model_type);
    if (modelType) {
      return normalizeArchitectureLabel(modelType);
    }
  }

  for (const record of getModelConfigRecords(config)) {
    const architectures = record.architectures;
    if (!Array.isArray(architectures)) {
      continue;
    }

    const architecture = architectures.find(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
    if (architecture) {
      return normalizeArchitectureLabel(architecture);
    }
  }

  return undefined;
}

function getCompanionContextLength(
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

function getCompanionParameterCount(
  config: Record<string, unknown>,
  filePath: string,
  modelName: string | undefined,
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
    modelName,
    getOptionalString(config._name_or_path),
    getOptionalString(config.name),
    path.basename(filePath, path.extname(filePath)),
    path.basename(path.dirname(filePath)),
  );
  if (nameBasedValue !== undefined) {
    return nameBasedValue;
  }

  return estimateDenseTransformerParameterCount(config, architecture);
}

function getCompanionTokenizer(
  directory: string,
  fileEntries: readonly string[],
  tokenizerConfig: Record<string, unknown>,
): string | undefined {
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
  if (fileEntries.some((entry) => /\.tiktoken$/i.test(entry))) {
    return "tiktoken";
  }
  if (fileEntries.some((entry) => /^tokenizer\.model$/i.test(entry))) {
    return "sentencepiece";
  }

  return undefined;
}

function shouldPreferCompanionTokenizer(
  tokenizer: string | undefined,
  companionTokenizer: string | undefined,
): boolean {
  if (!companionTokenizer) {
    return false;
  }
  if (!tokenizer) {
    return true;
  }

  return (
    GENERIC_TOKENIZER_PATTERN.test(tokenizer) ||
    GENERIC_TOKENIZER_CLASS_PATTERN.test(tokenizer)
  );
}

function readGgufCompanionMetadata(
  filePath: string,
  sniffed: SniffedGgufMetadata,
): GgufCompanionMetadata | undefined {
  const directory = path.dirname(filePath);
  const files = GGUF_COMPANION_FILE_NAMES.filter((fileName) =>
    existsSync(path.join(directory, fileName)),
  );
  if (files.length === 0) {
    return undefined;
  }

  const config = readJsonRecord(path.join(directory, "config.json"));
  const generationConfig = readJsonRecord(path.join(directory, "generation_config.json"));
  const tokenizerConfig = readJsonRecord(path.join(directory, "tokenizer_config.json"));
  const fileEntries = (() => {
    try {
      return readdirSync(directory);
    } catch {
      return [] as string[];
    }
  })();
  const modelName =
    getOptionalString(config._name_or_path) ??
    getOptionalString(config.name) ??
    sniffed.modelName;
  const architecture = getCompanionArchitecture(config);
  const contextLength = getCompanionContextLength(config, generationConfig, tokenizerConfig);
  const parameterCount = getCompanionParameterCount(config, filePath, modelName, architecture);
  const tokenizer = getCompanionTokenizer(directory, fileEntries, tokenizerConfig);

  return {
    files,
    ...(modelName ? { modelName } : {}),
    ...(architecture ? { architecture } : {}),
    ...(contextLength !== undefined ? { contextLength } : {}),
    ...(parameterCount !== undefined ? { parameterCount } : {}),
    ...(tokenizer ? { tokenizer } : {}),
  };
}

function mergeCompanionMetadata(
  filePath: string,
  sniffed: SniffedGgufMetadata,
): SniffedGgufMetadata {
  const companion = readGgufCompanionMetadata(filePath, sniffed);
  if (!companion) {
    return sniffed;
  }

  const metadata: Record<string, JsonValue> = {
    ...sniffed.metadata,
    "companion.files": companion.files,
  };
  if (companion.modelName) {
    metadata["companion.model_name"] = companion.modelName;
  }
  if (companion.architecture) {
    metadata["companion.architecture"] = companion.architecture;
  }
  if (companion.contextLength !== undefined) {
    metadata["companion.context_length"] = companion.contextLength;
  }
  if (companion.parameterCount !== undefined) {
    metadata["companion.parameter_count"] = companion.parameterCount;
  }
  if (companion.tokenizer) {
    metadata["companion.tokenizer"] = companion.tokenizer;
  }

  const tokenizer = shouldPreferCompanionTokenizer(sniffed.tokenizer, companion.tokenizer)
    ? companion.tokenizer
    : sniffed.tokenizer ?? companion.tokenizer;

  return {
    ...sniffed,
    metadata,
    ...(!sniffed.modelName && companion.modelName ? { modelName: companion.modelName } : {}),
    ...(companion.architecture ? { architecture: companion.architecture } : {}),
    ...(companion.contextLength !== undefined ? { contextLength: companion.contextLength } : {}),
    ...(companion.parameterCount !== undefined
      ? { parameterCount: companion.parameterCount }
      : {}),
    ...(tokenizer ? { tokenizer } : {}),
  };
}

export function hasGgufCompanionMetadataFiles(filePath: string): boolean {
  const directory = path.dirname(filePath);
  return GGUF_COMPANION_FILE_NAMES.some((fileName) => existsSync(path.join(directory, fileName)));
}

function deriveQuantization(
  metadata: Record<string, JsonValue>,
  fileName: string,
): string | undefined {
  const directKeys = [
    "general.quantization",
    "general.file_type_name",
    "general.quantization_type",
  ] as const;

  for (const key of directKeys) {
    const value = firstString(metadata[key]);
    if (value) {
      return value;
    }
  }

  const fileNameMatch = fileName.match(/\b(Q\d(?:_[A-Z]+)+)\b/i);
  return fileNameMatch?.[1]?.toUpperCase();
}

function deriveArchitecture(metadata: Record<string, JsonValue>): string | undefined {
  return (
    firstString(metadata["general.architecture"]) ??
    firstString(metadata["llm.architecture"]) ??
    firstString(metadata["model.architecture"])
  );
}

function deriveContextLength(
  metadata: Record<string, JsonValue>,
  architecture?: string,
): number | undefined {
  const keys = [
    "general.context_length",
    architecture ? `${architecture}.context_length` : undefined,
    "llama.context_length",
    "qwen2.context_length",
  ].filter((value): value is string => Boolean(value));

  for (const key of keys) {
    const value = firstNumber(metadata[key]);
    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}

function deriveParameterCount(
  metadata: Record<string, JsonValue>,
  architecture?: string,
): number | undefined {
  const keys = [
    "general.parameter_count",
    architecture ? `${architecture}.parameter_count` : undefined,
    "llama.parameter_count",
  ].filter((value): value is string => Boolean(value));

  for (const key of keys) {
    const value = firstNumber(metadata[key]);
    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}

function deriveEmbeddingLength(
  metadata: Record<string, JsonValue>,
  architecture?: string,
): number | undefined {
  const keys = [
    "general.embedding_length",
    architecture ? `${architecture}.embedding_length` : undefined,
    "llama.embedding_length",
    "qwen2.embedding_length",
  ].filter((value): value is string => Boolean(value));

  for (const key of keys) {
    const value = firstNumber(metadata[key]);
    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}

export async function sniffGgufFile(filePath: string): Promise<SniffedGgufMetadata> {
  const fileHandle = await open(filePath, "r");

  try {
    const cursor = new GgufCursor(fileHandle);
    const magic = (await cursor.readExactly(4)).toString("ascii");
    if (magic !== GGUF_MAGIC) {
      throw new Error(`Invalid GGUF magic header for ${filePath}.`);
    }

    const version = await cursor.readUint32();
    const tensorCount = await cursor.readSafeLength("GGUF tensor count");
    const metadataEntryCount = await cursor.readSafeLength("GGUF metadata count");
    const metadata: Record<string, JsonValue> = {};

    for (let entryIndex = 0; entryIndex < metadataEntryCount; entryIndex += 1) {
      const key = await cursor.readString();
      const valueType = (await cursor.readUint32()) as GgufValueType;
      metadata[key] = await readValue(cursor, valueType);
    }

    const fileName = path.basename(filePath);
    const architecture = deriveArchitecture(metadata);

    const sniffed: SniffedGgufMetadata = {
      format: "gguf",
      version,
      tensorCount,
      metadataEntryCount,
      metadata,
    };

    const modelName = firstString(metadata["general.name"]);
    const quantization = deriveQuantization(metadata, fileName);
    const contextLength = deriveContextLength(metadata, architecture);
    const parameterCount = deriveParameterCount(metadata, architecture);
    const embeddingLength = deriveEmbeddingLength(metadata, architecture);
    const tokenizer =
      firstString(metadata["tokenizer.ggml.model"]) ?? firstString(metadata["tokenizer.model"]);
    const chatTemplate =
      firstString(metadata["tokenizer.chat_template"]) ??
      firstString(metadata["tokenizer.ggml.chat_template"]);

    if (modelName) {
      sniffed.modelName = modelName;
    }
    if (architecture) {
      sniffed.architecture = architecture;
    }
    if (quantization) {
      sniffed.quantization = quantization;
    }
    if (contextLength !== undefined) {
      sniffed.contextLength = contextLength;
    }
    if (parameterCount !== undefined) {
      sniffed.parameterCount = parameterCount;
    }
    if (embeddingLength !== undefined) {
      sniffed.embeddingLength = embeddingLength;
    }
    if (tokenizer) {
      sniffed.tokenizer = tokenizer;
    }
    if (chatTemplate) {
      sniffed.chatTemplate = chatTemplate;
    }

    return sniffed;
  } finally {
    await fileHandle.close();
  }
}

export async function inspectGgufFile(filePath: string): Promise<SniffedGgufMetadata> {
  return mergeCompanionMetadata(filePath, await sniffGgufFile(filePath));
}

export async function computeFileSha256(filePath: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);

    stream.on("data", (chunk) => {
      hash.update(chunk);
    });
    stream.on("end", () => {
      resolve(hash.digest("hex"));
    });
    stream.on("error", reject);
  });
}

export async function verifyGgufFile(
  filePath: string,
  expectedChecksumSha256?: string,
): Promise<GgufVerificationResult> {
  if (path.extname(filePath).toLowerCase() !== ".gguf") {
    throw new Error(`Expected a .gguf artifact, received ${filePath}.`);
  }

  const [metadata, checksumSha256, stats] = await Promise.all([
    inspectGgufFile(filePath),
    computeFileSha256(filePath),
    open(filePath, "r").then(async (handle) => {
      try {
        return await handle.stat();
      } finally {
        await handle.close();
      }
    }),
  ]);

  const matchesExpectedChecksum = expectedChecksumSha256
    ? checksumSha256 === expectedChecksumSha256
    : undefined;

  if (matchesExpectedChecksum === false) {
    throw new Error(`Checksum mismatch for ${filePath}.`);
  }

  return {
    filePath,
    fileName: path.basename(filePath),
    sizeBytes: stats.size,
    checksumSha256,
    matchesExpectedChecksum,
    metadata,
  };
}

export function toArtifactMetadata(sniffed: SniffedGgufMetadata): ModelArtifact["metadata"] {
  const metadata: GgufMetadata["metadata"] = {
    ...sniffed.metadata,
    ...(sniffed.embeddingLength !== undefined ? { embeddingLength: sniffed.embeddingLength } : {}),
    ...(sniffed.chatTemplate ? { chatTemplate: sniffed.chatTemplate } : {}),
  };

  return {
    schemaVersion: 1,
    ...(sniffed.architecture ? { architecture: sniffed.architecture } : {}),
    ...(sniffed.quantization ? { quantization: sniffed.quantization } : {}),
    ...(sniffed.contextLength !== undefined ? { contextLength: sniffed.contextLength } : {}),
    ...(sniffed.parameterCount !== undefined ? { parameterCount: sniffed.parameterCount } : {}),
    tensorCount: sniffed.tensorCount,
    ...(sniffed.tokenizer ? { tokenizer: sniffed.tokenizer } : {}),
    metadata,
  };
}
