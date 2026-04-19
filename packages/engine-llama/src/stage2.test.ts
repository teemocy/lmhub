import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { EngineVersionsRepository, ModelsRepository, createTestDatabase } from "@localhub/db";
import { afterEach, describe, expect, it } from "vitest";

import { computeFileSha256, sniffGgufFile, verifyGgufFile } from "./gguf.js";
import { createLlamaCppAdapter } from "./index.js";
import { LlamaCppModelManager } from "./model-manager.js";

const tempDirs: string[] = [];
const cleanups: Array<() => void> = [];
const activeSessions: Array<Awaited<ReturnType<LlamaCppModelManager["launchRegisteredModel"]>>> =
  [];

enum TestGgufValueType {
  Uint32 = 4,
  String = 8,
  Uint64 = 10,
}

interface SampleGgufOptions {
  modelName?: string;
  architecture?: string;
  quantization?: string;
  contextLength?: number;
  embeddingLength?: number;
  parameterCount?: number;
  tokenizer?: string;
  chatTemplate?: string;
}

function uint32Buffer(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value, 0);
  return buffer;
}

function uint64Buffer(value: number): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value), 0);
  return buffer;
}

function stringBuffer(value: string): Buffer {
  const utf8 = Buffer.from(value, "utf8");
  return Buffer.concat([uint64Buffer(utf8.length), utf8]);
}

function createMetadataEntry(
  key: string,
  valueType: TestGgufValueType,
  value: string | number,
): Buffer {
  let valueBuffer: Buffer;

  switch (valueType) {
    case TestGgufValueType.String:
      valueBuffer = stringBuffer(String(value));
      break;
    case TestGgufValueType.Uint32:
      valueBuffer = uint32Buffer(Number(value));
      break;
    case TestGgufValueType.Uint64:
      valueBuffer = uint64Buffer(Number(value));
      break;
    default:
      throw new Error(`Unsupported test GGUF value type: ${valueType}`);
  }

  return Buffer.concat([stringBuffer(key), uint32Buffer(valueType), valueBuffer]);
}

async function createSupportRoot(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "localhub-engine-stage2-"));
  tempDirs.push(directory);
  return directory;
}

async function writeSampleGgufFile(
  targetPath: string,
  options: SampleGgufOptions = {},
): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true });

  const entries = [
    createMetadataEntry(
      "general.name",
      TestGgufValueType.String,
      options.modelName ?? "Stage2 Tiny Chat",
    ),
    createMetadataEntry(
      "general.architecture",
      TestGgufValueType.String,
      options.architecture ?? "llama",
    ),
    createMetadataEntry(
      "general.quantization",
      TestGgufValueType.String,
      options.quantization ?? "Q4_K_M",
    ),
    createMetadataEntry(
      `${options.architecture ?? "llama"}.context_length`,
      TestGgufValueType.Uint32,
      options.contextLength ?? 8192,
    ),
    createMetadataEntry(
      `${options.architecture ?? "llama"}.embedding_length`,
      TestGgufValueType.Uint32,
      options.embeddingLength ?? 4096,
    ),
    createMetadataEntry(
      "general.parameter_count",
      TestGgufValueType.Uint64,
      options.parameterCount ?? 123456789,
    ),
    createMetadataEntry(
      "tokenizer.ggml.model",
      TestGgufValueType.String,
      options.tokenizer ?? "gpt2",
    ),
    createMetadataEntry(
      "tokenizer.chat_template",
      TestGgufValueType.String,
      options.chatTemplate ?? "<s>{{prompt}}</s>",
    ),
  ];

  const payload = Buffer.concat([
    Buffer.from("GGUF", "ascii"),
    uint32Buffer(3),
    uint64Buffer(0),
    uint64Buffer(entries.length),
    ...entries,
  ]);

  await writeFile(targetPath, payload);
}

afterEach(async () => {
  while (activeSessions.length > 0) {
    const session = activeSessions.pop();
    if (!session) {
      continue;
    }

    await session.stop().catch(() => undefined);
  }

  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    cleanup?.();
  }

  while (tempDirs.length > 0) {
    const directory = tempDirs.pop();
    if (!directory) {
      continue;
    }

    await rm(directory, { recursive: true, force: true });
  }
});

describe("llama.cpp stage 2 vertical slice", () => {
  it("sniffs GGUF metadata and verifies checksums for a local artifact", async () => {
    const supportRoot = await createSupportRoot();
    const artifactPath = path.join(supportRoot, "models", "stage2-tiny-chat.gguf");
    await writeSampleGgufFile(artifactPath);

    const sniffed = await sniffGgufFile(artifactPath);
    const checksumSha256 = await computeFileSha256(artifactPath);
    const verified = await verifyGgufFile(artifactPath, checksumSha256);

    expect(sniffed.format).toBe("gguf");
    expect(sniffed.version).toBe(3);
    expect(sniffed.architecture).toBe("llama");
    expect(sniffed.quantization).toBe("Q4_K_M");
    expect(sniffed.contextLength).toBe(8192);
    expect(sniffed.parameterCount).toBe(123456789);
    expect(verified.checksumSha256).toBe(checksumSha256);
    expect(verified.matchesExpectedChecksum).toBe(true);
  });

  it("registers and indexes a local GGUF through Thread 1 persistence", async () => {
    const supportRoot = await createSupportRoot();
    const artifactPath = path.join(supportRoot, "models", "stage2-tiny-chat.gguf");
    await writeSampleGgufFile(artifactPath);

    const testDatabase = createTestDatabase();
    cleanups.push(testDatabase.cleanup);

    const manager = new LlamaCppModelManager({
      supportRoot,
      localModelsDir: path.join(supportRoot, "models"),
      adapter: createLlamaCppAdapter({
        supportRoot,
        preferFakeWorker: true,
        fakeWorkerStartupDelayMs: 20,
      }),
      modelsRepository: new ModelsRepository(testDatabase.database),
      engineVersionsRepository: new EngineVersionsRepository(testDatabase.database),
    });

    const registered = await manager.registerLocalModel({
      filePath: artifactPath,
      tags: ["stage2", "chat"],
      promptCacheKey: "stage2-cache",
    });
    const indexedModels = manager.listIndexedModels();

    expect(registered.artifact.source.checksumSha256).toBeDefined();
    expect(registered.artifact.metadata.contextLength).toBe(8192);
    expect(registered.profile.role).toBe("chat");
    expect(indexedModels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          artifactId: registered.artifact.id,
          displayName: "Stage2 Tiny Chat",
          quantization: "Q4_K_M",
          contextLength: 8192,
          checksumSha256: registered.checksumSha256,
        }),
      ]),
    );
  });

  it("registers companion config metadata for a local GGUF when sidecars are present", async () => {
    const supportRoot = await createSupportRoot();
    const artifactPath = path.join(supportRoot, "models", "qwen3.5-35b-a3b.gguf");
    await writeSampleGgufFile(artifactPath, {
      modelName: "Qwen3.5-35B-A3B",
      architecture: "llama",
      contextLength: 32768,
      parameterCount: 123_000_000,
      tokenizer: "gpt2",
    });
    await writeFile(
      path.join(path.dirname(artifactPath), "config.json"),
      `${JSON.stringify(
        {
          _name_or_path: "Qwen3.5-35B-A3B",
          model_type: "qwen3_moe",
          max_position_embeddings: 262144,
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      path.join(path.dirname(artifactPath), "tokenizer_config.json"),
      `${JSON.stringify(
        {
          tokenizer_class: "Qwen2TokenizerFast",
        },
        null,
        2,
      )}\n`,
    );

    const testDatabase = createTestDatabase();
    cleanups.push(testDatabase.cleanup);

    const manager = new LlamaCppModelManager({
      supportRoot,
      localModelsDir: path.join(supportRoot, "models"),
      adapter: createLlamaCppAdapter({
        supportRoot,
        preferFakeWorker: true,
        fakeWorkerStartupDelayMs: 20,
      }),
      modelsRepository: new ModelsRepository(testDatabase.database),
      engineVersionsRepository: new EngineVersionsRepository(testDatabase.database),
    });

    const registered = await manager.registerLocalModel({
      filePath: artifactPath,
    });

    expect(registered.artifact.architecture).toBe("qwen3_moe");
    expect(registered.artifact.metadata.contextLength).toBe(262144);
    expect(registered.artifact.metadata.parameterCount).toBe(35_000_000_000);
    expect(registered.artifact.metadata.tokenizer).toBe("Qwen2TokenizerFast");
    expect(registered.profile.parameterOverrides.contextLength).toBe(262144);
    expect(registered.artifact.metadata.metadata["companion.files"]).toEqual(
      expect.arrayContaining(["config.json", "tokenizer_config.json"]),
    );
  });

  it("refreshes registered GGUF metadata from companion config without clobbering custom overrides", async () => {
    const supportRoot = await createSupportRoot();
    const artifactPath = path.join(supportRoot, "models", "qwen3.5-35b-a3b.gguf");
    await writeSampleGgufFile(artifactPath, {
      modelName: "Qwen3.5-35B-A3B",
      architecture: "llama",
      contextLength: 32768,
      parameterCount: 123_000_000,
      tokenizer: "gpt2",
    });

    const testDatabase = createTestDatabase();
    cleanups.push(testDatabase.cleanup);
    const modelsRepository = new ModelsRepository(testDatabase.database);

    const manager = new LlamaCppModelManager({
      supportRoot,
      localModelsDir: path.join(supportRoot, "models"),
      adapter: createLlamaCppAdapter({
        supportRoot,
        preferFakeWorker: true,
        fakeWorkerStartupDelayMs: 20,
      }),
      modelsRepository,
      engineVersionsRepository: new EngineVersionsRepository(testDatabase.database),
    });

    const registered = await manager.registerLocalModel({
      filePath: artifactPath,
    });
    expect(registered.profile.parameterOverrides.contextLength).toBe(32768);

    await writeFile(
      path.join(path.dirname(artifactPath), "config.json"),
      `${JSON.stringify(
        {
          _name_or_path: "Qwen3.5-35B-A3B",
          model_type: "qwen3_moe",
          max_position_embeddings: 262144,
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(
      path.join(path.dirname(artifactPath), "tokenizer_config.json"),
      `${JSON.stringify(
        {
          tokenizer_class: "Qwen2TokenizerFast",
        },
        null,
        2,
      )}\n`,
    );

    const refreshed = await manager.refreshLocalModelMetadata(artifactPath);
    expect(refreshed.artifact.metadata.contextLength).toBe(262144);
    expect(refreshed.profile.parameterOverrides.contextLength).toBe(262144);

    modelsRepository.save(refreshed.artifact, {
      ...refreshed.profile,
      parameterOverrides: {
        ...refreshed.profile.parameterOverrides,
        contextLength: 65536,
      },
    });

    const preserved = await manager.refreshLocalModelMetadata(artifactPath);
    expect(preserved.artifact.metadata.contextLength).toBe(262144);
    expect(preserved.profile.parameterOverrides.contextLength).toBe(65536);
  });

  it("classifies embedding, rerank, and multimodal companion models from local GGUF metadata", async () => {
    const supportRoot = await createSupportRoot();
    const modelsRoot = path.join(supportRoot, "models");
    const embeddingPath = path.join(modelsRoot, "stage2-embedding.gguf");
    const rerankerPath = path.join(modelsRoot, "stage2-reranker.gguf");
    const multimodalDir = path.join(modelsRoot, "stage2-multimodal");
    const multimodalPath = path.join(multimodalDir, "stage2-vision-chat.gguf");
    const mmprojPath = path.join(multimodalDir, "mmproj-stage2-vision-chat.gguf");

    await writeSampleGgufFile(embeddingPath, {
      modelName: "Stage2 Embedding",
      architecture: "qwen3",
      contextLength: 40960,
      embeddingLength: 2560,
      chatTemplate: "{{messages}}",
    });
    await writeSampleGgufFile(rerankerPath, {
      modelName: "Stage2 Reranker",
      architecture: "qwen3",
      contextLength: 40960,
      embeddingLength: 2560,
      chatTemplate: "{{messages}}",
    });
    await writeSampleGgufFile(multimodalPath, {
      modelName: "Stage2 Vision Chat",
      architecture: "qwen35moe",
      contextLength: 262144,
      embeddingLength: 2048,
      chatTemplate: "<|vision_start|><|image_pad|><|vision_end|>{{messages}}",
    });
    await writeSampleGgufFile(mmprojPath, {
      modelName: "Stage2 Vision Chat Projector",
      architecture: "clip",
      embeddingLength: 1024,
      chatTemplate: "",
    });

    const testDatabase = createTestDatabase();
    cleanups.push(testDatabase.cleanup);

    const manager = new LlamaCppModelManager({
      supportRoot,
      localModelsDir: path.join(supportRoot, "models"),
      adapter: createLlamaCppAdapter({
        supportRoot,
        preferFakeWorker: true,
      }),
      modelsRepository: new ModelsRepository(testDatabase.database),
      engineVersionsRepository: new EngineVersionsRepository(testDatabase.database),
    });

    const embeddingModel = await manager.registerLocalModel({
      filePath: embeddingPath,
    });
    const rerankerModel = await manager.registerLocalModel({
      filePath: rerankerPath,
    });
    const multimodalModel = await manager.registerLocalModel({
      filePath: multimodalPath,
    });

    expect(embeddingModel.artifact.capabilities.embeddings).toBe(true);
    expect(embeddingModel.artifact.capabilities.chat).toBe(false);
    expect(embeddingModel.profile.role).toBe("embeddings");

    expect(rerankerModel.artifact.capabilities.rerank).toBe(true);
    expect(rerankerModel.artifact.capabilities.chat).toBe(false);
    expect(rerankerModel.profile.role).toBe("rerank");

    expect(multimodalModel.artifact.capabilities.chat).toBe(true);
    expect(multimodalModel.artifact.capabilities.vision).toBe(true);
    expect(multimodalModel.profile.role).toBe("chat");
    expect(multimodalModel.artifact.metadata.metadata.mmprojPath).toBe(mmprojPath);
  });

  it("auto-discovers GGUFs in the configured local models directory and skips projector sidecars", async () => {
    const supportRoot = await createSupportRoot();
    const localModelsDir = path.join(supportRoot, "scan");
    const chatPath = path.join(localModelsDir, "nested", "stage2-scan-chat.gguf");
    const projectorPath = path.join(localModelsDir, "nested", "mmproj-stage2-scan-chat.gguf");

    await writeSampleGgufFile(chatPath, {
      modelName: "Stage2 Scan Chat",
      architecture: "llama",
      chatTemplate: "<s>{{prompt}}</s>",
    });
    await writeSampleGgufFile(projectorPath, {
      modelName: "Stage2 Scan Projector",
      architecture: "clip",
      chatTemplate: "",
    });

    const testDatabase = createTestDatabase();
    cleanups.push(testDatabase.cleanup);

    const manager = new LlamaCppModelManager({
      supportRoot,
      localModelsDir,
      adapter: createLlamaCppAdapter({
        supportRoot,
        preferFakeWorker: true,
      }),
      modelsRepository: new ModelsRepository(testDatabase.database),
      engineVersionsRepository: new EngineVersionsRepository(testDatabase.database),
    });

    const scanned = await manager.scanLocalModels();

    expect(scanned).toHaveLength(1);
    expect(scanned[0]?.indexed.localPath).toBe(chatPath);
    expect(manager.listIndexedModels()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          localPath: chatPath,
        }),
      ]),
    );
  });

  it("launches a registered local artifact, reports readiness, and shuts down cleanly", async () => {
    const supportRoot = await createSupportRoot();
    const artifactPath = path.join(supportRoot, "models", "stage2-tiny-chat.gguf");
    await writeSampleGgufFile(artifactPath);

    const testDatabase = createTestDatabase();
    cleanups.push(testDatabase.cleanup);

    const manager = new LlamaCppModelManager({
      supportRoot,
      localModelsDir: path.join(supportRoot, "models"),
      adapter: createLlamaCppAdapter({
        supportRoot,
        preferFakeWorker: true,
        fakeWorkerStartupDelayMs: 20,
      }),
      modelsRepository: new ModelsRepository(testDatabase.database),
      engineVersionsRepository: new EngineVersionsRepository(testDatabase.database),
    });

    const registered = await manager.registerLocalModel({
      filePath: artifactPath,
      tags: ["stage2", "chat"],
    });
    const session = await manager.launchRegisteredModel({
      artifactId: registered.artifact.id,
    });
    activeSessions.push(session);

    const readyHealth = await session.checkHealth();
    expect(readyHealth.ok).toBe(true);
    expect(readyHealth.snapshot?.state).toBe("ready");

    const indexedModel = manager.findIndexedModel(registered.artifact.id);
    expect(indexedModel?.loadCount).toBe(1);

    await session.stop();

    const stoppedHealth = await session.checkHealth();
    expect(stoppedHealth.ok).toBe(false);
    expect(stoppedHealth.snapshot?.state).toBe("offline");
  });
});
