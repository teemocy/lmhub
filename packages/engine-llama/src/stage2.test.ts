import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  EngineVersionsRepository,
  ModelsRepository,
  createTestDatabase,
} from "@localhub/db";
import { afterEach, describe, expect, it } from "vitest";

import { createLlamaCppAdapter } from "./index.js";
import { computeFileSha256, sniffGgufFile, verifyGgufFile } from "./gguf.js";
import { LlamaCppModelManager } from "./model-manager.js";

const tempDirs: string[] = [];
const cleanups: Array<() => void> = [];
const activeSessions: Array<Awaited<ReturnType<LlamaCppModelManager["launchRegisteredModel"]>>> = [];

enum TestGgufValueType {
  Uint32 = 4,
  String = 8,
  Uint64 = 10,
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

async function writeSampleGgufFile(targetPath: string): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true });

  const entries = [
    createMetadataEntry("general.name", TestGgufValueType.String, "Stage2 Tiny Chat"),
    createMetadataEntry("general.architecture", TestGgufValueType.String, "llama"),
    createMetadataEntry("general.quantization", TestGgufValueType.String, "Q4_K_M"),
    createMetadataEntry("llama.context_length", TestGgufValueType.Uint32, 8192),
    createMetadataEntry("llama.embedding_length", TestGgufValueType.Uint32, 4096),
    createMetadataEntry("general.parameter_count", TestGgufValueType.Uint64, 123456789),
    createMetadataEntry("tokenizer.ggml.model", TestGgufValueType.String, "gpt2"),
    createMetadataEntry("tokenizer.chat_template", TestGgufValueType.String, "<s>{{prompt}}</s>"),
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

  it("launches a registered local artifact, reports readiness, and shuts down cleanly", async () => {
    const supportRoot = await createSupportRoot();
    const artifactPath = path.join(supportRoot, "models", "stage2-tiny-chat.gguf");
    await writeSampleGgufFile(artifactPath);

    const testDatabase = createTestDatabase();
    cleanups.push(testDatabase.cleanup);

    const manager = new LlamaCppModelManager({
      supportRoot,
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
