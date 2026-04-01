import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

import type { GgufMetadata, ModelArtifact } from "@localhub/shared-contracts/foundation-models";

const GGUF_MAGIC = "GGUF";
const MAX_SAFE_U64 = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_ARRAY_SAMPLE = 8;

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

async function readScalarValue(
  cursor: GgufCursor,
  valueType: GgufValueType,
): Promise<JsonValue> {
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

async function readValue(
  cursor: GgufCursor,
  valueType: GgufValueType,
): Promise<JsonValue> {
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

function deriveContextLength(metadata: Record<string, JsonValue>, architecture?: string): number | undefined {
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
      firstString(metadata["tokenizer.ggml.model"]) ??
      firstString(metadata["tokenizer.model"]);
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
    sniffGgufFile(filePath),
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
    ...(sniffed.embeddingLength !== undefined
      ? { embeddingLength: sniffed.embeddingLength }
      : {}),
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
