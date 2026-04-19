import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ModelsRepository, createTestDatabase } from "@localhub/db";
import type { EngineAdapter } from "@localhub/engine-core";
import { afterEach, describe, expect, it } from "vitest";

import { MlxModelManager, isMlxModelDirectoryPath } from "./model-manager.js";

const tempDirs: string[] = [];
const cleanups: Array<() => void | Promise<void>> = [];

const fakeAdapter: EngineAdapter = {
  engineType: "mlx",
  async probe() {
    return {
      available: true,
      resolvedVia: "fake-worker",
      registry: {
        engineType: "mlx",
        versions: [],
        updatedAt: new Date().toISOString(),
      },
      notes: [],
    };
  },
  async install(versionTag, _options) {
    return {
      success: true,
      versionTag,
      registryFile: "/tmp/registry.json",
      activated: true,
      notes: [],
    };
  },
  async activate(versionTag) {
    return {
      success: true,
      versionTag,
      registryFile: "/tmp/registry.json",
      notes: [],
    };
  },
  async resolveCommand() {
    throw new Error("Not used in this test.");
  },
  async healthCheck() {
    return {
      ok: true,
      notes: [],
    };
  },
  normalizeResponse(payload) {
    return payload;
  },
  capabilities(artifact) {
    return artifact.capabilities;
  },
};

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }

  while (tempDirs.length > 0) {
    const directory = tempDirs.pop();
    if (directory) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

describe("mlx model manager", () => {
  it("scans and registers an MLX directory even when config.json is missing", async () => {
    const supportRoot = await mkdtemp(path.join(os.tmpdir(), "localhub-engine-mlx-"));
    tempDirs.push(supportRoot);

    const database = createTestDatabase();
    cleanups.push(database.cleanup);

    const localModelsDir = path.join(supportRoot, "models");
    const modelDir = path.join(localModelsDir, "Qwen3.5-9B-MLX-4bit");
    await mkdir(modelDir, { recursive: true });
    await writeFile(path.join(modelDir, "tokenizer.json"), "{}\n");
    await writeFile(path.join(modelDir, "model.safetensors"), "");

    expect(isMlxModelDirectoryPath(modelDir)).toBe(true);

    const manager = new MlxModelManager({
      supportRoot,
      localModelsDir,
      adapter: fakeAdapter,
      modelsRepository: new ModelsRepository(database.database),
    });

    const registered = await manager.scanLocalModels();

    expect(registered).toHaveLength(1);
    expect(registered[0]).toMatchObject({
      artifact: {
        format: "mlx",
        localPath: modelDir,
      },
      profile: {
        engineType: "mlx",
      },
      metadata: {
        shardCount: 1,
      },
    });
    expect(registered[0]?.artifact.name).toBe("Qwen3.5 9B MLX 4bit");
  });

  it("derives MLX metadata from bundled configuration sidecars", async () => {
    const supportRoot = await mkdtemp(path.join(os.tmpdir(), "localhub-engine-mlx-"));
    tempDirs.push(supportRoot);

    const database = createTestDatabase();
    cleanups.push(database.cleanup);

    const localModelsDir = path.join(supportRoot, "models");
    const modelDir = path.join(localModelsDir, "Qwen3.5-1.5B-Instruct-4bit");
    await mkdir(modelDir, { recursive: true });
    await writeFile(
      path.join(modelDir, "config.json"),
      JSON.stringify({
        _name_or_path: "mlx-community/Qwen3.5-1.5B-Instruct-4bit",
        model_type: "qwen2",
        max_position_embeddings: 32768,
        hidden_size: 1536,
        num_hidden_layers: 28,
        intermediate_size: 8960,
        num_attention_heads: 12,
        num_key_value_heads: 2,
        vocab_size: 151936,
      }),
    );
    await writeFile(
      path.join(modelDir, "tokenizer_config.json"),
      JSON.stringify({
        tokenizer_class: "Qwen2Tokenizer",
      }),
    );
    await writeFile(path.join(modelDir, "tokenizer.json"), '{"model":{"type":"BPE"}}\n');
    await writeFile(
      path.join(modelDir, "quant_strategy.json"),
      JSON.stringify({
        bits: 4,
        group_size: 64,
      }),
    );
    await writeFile(path.join(modelDir, "model.safetensors"), "");

    const manager = new MlxModelManager({
      supportRoot,
      localModelsDir,
      adapter: fakeAdapter,
      modelsRepository: new ModelsRepository(database.database),
    });

    const registered = await manager.registerLocalModel({ filePath: modelDir });

    expect(registered.metadata).toMatchObject({
      architecture: "qwen2",
      contextLength: 32768,
      parameterCount: 1_500_000_000,
      tokenizer: "Qwen2Tokenizer",
      quantization: "4-bit-g64",
      shardCount: 1,
    });
    expect(registered.artifact.metadata).toMatchObject({
      architecture: "qwen2",
      contextLength: 32768,
      parameterCount: 1_500_000_000,
      tokenizer: "Qwen2Tokenizer",
      quantization: "4-bit-g64",
    });
  });
});
