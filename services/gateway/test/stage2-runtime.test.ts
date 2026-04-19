import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ChatRepository,
  EngineVersionsRepository,
  ModelsRepository,
  fixtureEngineVersion,
  fixtureModelArtifact,
  fixtureModelProfile,
  openDatabase,
} from "@localhub/db";
import {
  readEngineVersionRegistry,
  resolveEngineSupportPaths,
  writeEngineVersionRegistry,
} from "@localhub/engine-core";
import { resolveAppPaths } from "@localhub/platform";
import { afterEach, describe, expect, it } from "vitest";

import type { GatewayConfig } from "../src/config.js";
import { createRepositoryGatewayRuntime } from "../src/runtime/repositoryRuntime.js";
import { buildGateway } from "../src/server/app.js";
import { GatewayRequestError } from "../src/types.js";

const migrationsDir = path.resolve(import.meta.dirname, "../../../packages/db/migrations");

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
  const valueBuffer =
    valueType === TestGgufValueType.String
      ? stringBuffer(String(value))
      : valueType === TestGgufValueType.Uint32
        ? uint32Buffer(Number(value))
        : uint64Buffer(Number(value));

  return Buffer.concat([stringBuffer(key), uint32Buffer(valueType), valueBuffer]);
}

async function writeSampleGgufFile(targetPath: string): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true });

  const entries = [
    createMetadataEntry("general.name", TestGgufValueType.String, "Gateway Stage2 Tiny Chat"),
    createMetadataEntry("general.architecture", TestGgufValueType.String, "llama"),
    createMetadataEntry("general.quantization", TestGgufValueType.String, "Q4_K_M"),
    createMetadataEntry("llama.context_length", TestGgufValueType.Uint32, 8192),
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

async function writeSampleMlxModelDirectory(targetPath: string): Promise<void> {
  await mkdir(targetPath, { recursive: true });
  await writeFile(
    path.join(targetPath, "config.json"),
    `${JSON.stringify(
      {
        _name_or_path: "Gateway Stage2 MLX Chat",
        model_type: "llama",
        max_position_embeddings: 4096,
        num_parameters: 123456789,
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(path.join(targetPath, "tokenizer.json"), "{}\n");
  await writeFile(path.join(targetPath, "special_tokens_map.json"), "{}\n");
  await writeFile(path.join(targetPath, "quant_strategy.json"), `${JSON.stringify({ bits: 4 })}\n`);
  await writeFile(path.join(targetPath, "model.safetensors"), "");
}

function createDelayedChatResponse(model: string, userMessage: string, delayMs: number): Response {
  const encoder = new TextEncoder();
  const created = Math.floor(Date.now() / 1000);
  const payload = {
    id: `chatcmpl_${created}_${delayMs}`,
    object: "chat.completion",
    created,
    model,
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: {
          role: "assistant" as const,
          content: `Fake response from ${model}: ${userMessage}`,
        },
      },
    ],
    usage: {
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 2,
    },
  };

  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        setTimeout(() => {
          controller.enqueue(encoder.encode(JSON.stringify(payload)));
          controller.close();
        }, delayMs);
      },
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
      },
    },
  );
}

function createReasoningChatStreamResponse(model: string): Response {
  const encoder = new TextEncoder();
  const created = Math.floor(Date.now() / 1000);
  const completionId = `chatcmpl_${created}_reasoning`;
  const chunks = [
    {
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { role: "assistant" as const }, finish_reason: null }],
    },
    {
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta: {
            reasoning_content: "counterrevolutionary hyperparameterization metamorphosis",
          },
          finish_reason: null,
        },
      ],
    },
    {
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta: {
            content: "finalization",
          },
          finish_reason: null,
        },
      ],
    },
    {
      id: completionId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
  ];

  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }),
    {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
      },
    },
  );
}

interface Stage2Fixture {
  appPaths: ReturnType<typeof resolveAppPaths>;
  artifactPaths: Record<string, string>;
  cleanup: () => Promise<void>;
  runtime: ReturnType<typeof createRepositoryGatewayRuntime>;
}

const fixtures: Stage2Fixture[] = [];
const supportsMlxTests = process.platform === "darwin" && process.arch === "arm64";
const embeddingsModelArtifact = {
  ...fixtureModelArtifact,
  id: "model_bge_small_embed",
  name: "BGE Small Embed",
  localPath: "/models/bge-small-embed.gguf",
  capabilities: {
    ...fixtureModelArtifact.capabilities,
    chat: false,
    embeddings: true,
    tools: false,
    promptCache: false,
  },
};
const embeddingsModelProfile = {
  ...fixtureModelProfile,
  id: "profile_bge_small_embed_default",
  modelId: embeddingsModelArtifact.id,
  displayName: "BGE Small Embed",
  role: "embeddings" as const,
  parameterOverrides: {},
};
const rerankModelArtifact = {
  ...fixtureModelArtifact,
  id: "model_jina_reranker",
  name: "Jina Reranker",
  localPath: "/models/jina-reranker.gguf",
  capabilities: {
    ...fixtureModelArtifact.capabilities,
    chat: false,
    rerank: true,
    tools: false,
    promptCache: false,
  },
};
const rerankModelProfile = {
  ...fixtureModelProfile,
  id: "profile_jina_reranker_default",
  modelId: rerankModelArtifact.id,
  displayName: "Jina Reranker",
  role: "rerank" as const,
  parameterOverrides: {},
};
const secondaryChatModelArtifact = {
  ...fixtureModelArtifact,
  id: "model_qwen25_chat_secondary",
  name: "Qwen 2.5 Chat Secondary",
  localPath: "/models/qwen2.5-chat-secondary.gguf",
};
const secondaryChatModelProfile = {
  ...fixtureModelProfile,
  id: "profile_qwen25_chat_secondary_default",
  modelId: secondaryChatModelArtifact.id,
  displayName: "Qwen 2.5 Chat Secondary",
};

interface CreateStage2FixtureOptions {
  extraSeedModels?: Array<{
    artifact: typeof fixtureModelArtifact;
    fileName: string;
    profile: typeof fixtureModelProfile;
  }>;
  runtimeOverrides?: Partial<Parameters<typeof createRepositoryGatewayRuntime>[0]>;
}

function createTestConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    defaultModelTtlMs: 1_000,
    maxActiveModelsInMemory: 0,
    publicHost: "127.0.0.1",
    publicPort: 11434,
    controlHost: "127.0.0.1",
    controlPort: 11435,
    localModelsDir: path.join(os.tmpdir(), "localhub-gateway-models"),
    publicBearerToken: "public-secret-stage2",
    controlBearerToken: "control-secret-stage2",
    corsAllowlist: ["localhost", "127.0.0.1"],
    telemetryIntervalMs: 50,
    ...overrides,
  };
}

async function createStage2Fixture(
  options: CreateStage2FixtureOptions = {},
): Promise<Stage2Fixture> {
  const supportRoot = await mkdtemp(path.join(os.tmpdir(), "localhub-gateway-stage2-"));
  const appPaths = resolveAppPaths({
    cwd: process.cwd(),
    environment: "test",
    supportRoot,
  });
  const seeded = openDatabase({
    filePath: appPaths.databaseFile,
    migrationsDir,
  });
  const models = new ModelsRepository(seeded.database);
  const seededArtifactPath = path.join(appPaths.modelsDir, "fixture-qwen25-coder.gguf");
  const seededEmbeddingPath = path.join(appPaths.modelsDir, "fixture-bge-small-embed.gguf");
  const seededRerankPath = path.join(appPaths.modelsDir, "fixture-jina-reranker.gguf");
  const artifactPaths: Record<string, string> = {
    [fixtureModelArtifact.id]: seededArtifactPath,
    [embeddingsModelArtifact.id]: seededEmbeddingPath,
    [rerankModelArtifact.id]: seededRerankPath,
  };

  await writeSampleGgufFile(seededArtifactPath);
  await writeSampleGgufFile(seededEmbeddingPath);
  await writeSampleGgufFile(seededRerankPath);

  models.save(
    {
      ...fixtureModelArtifact,
      localPath: seededArtifactPath,
    },
    fixtureModelProfile,
  );
  models.save(
    {
      ...embeddingsModelArtifact,
      localPath: seededEmbeddingPath,
    },
    embeddingsModelProfile,
  );
  models.save(
    {
      ...rerankModelArtifact,
      localPath: seededRerankPath,
    },
    rerankModelProfile,
  );

  for (const seedModel of options.extraSeedModels ?? []) {
    const artifactPath = path.join(appPaths.modelsDir, seedModel.fileName);
    artifactPaths[seedModel.artifact.id] = artifactPath;
    await writeSampleGgufFile(artifactPath);
    models.save(
      {
        ...seedModel.artifact,
        localPath: artifactPath,
      },
      seedModel.profile,
    );
  }
  seeded.database.close();

  const runtime = createRepositoryGatewayRuntime({
    cwd: process.cwd(),
    defaultModelTtlMs: 1_000,
    env: {
      ...process.env,
      LOCAL_LLM_HUB_ENV: "test",
    },
    fakeWorkerStartupDelayMs: 25,
    preferFakeWorker: true,
    supportRoot,
    localModelsDir: path.join(supportRoot, "models"),
    telemetryIntervalMs: 50,
    ...options.runtimeOverrides,
  });
  await runtime.start();

  const fixture = {
    appPaths,
    artifactPaths,
    async cleanup() {
      await runtime.stop();
      await rm(supportRoot, { recursive: true, force: true });
    },
    runtime,
  };

  fixtures.push(fixture);
  return fixture;
}

afterEach(async () => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop();
    if (!fixture) {
      continue;
    }

    await fixture.cleanup();
  }
});

describe("gateway stage 2 runtime", () => {
  it("lists repository-backed models through the public v1 route", async () => {
    const fixture = await createStage2Fixture();
    const gateway = await buildGateway({
      config: createTestConfig(),
      runtime: fixture.runtime,
    });

    await Promise.all([gateway.publicApp.ready(), gateway.controlApp.ready()]);

    const response = await gateway.publicApp.inject({
      method: "GET",
      url: "/v1/models",
      headers: {
        authorization: "Bearer public-secret-stage2",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      object: "list",
      data: expect.arrayContaining([
        expect.objectContaining({
          id: fixtureModelProfile.displayName,
          model_id: fixtureModelArtifact.id,
        }),
      ]),
    });

    await Promise.allSettled([gateway.publicApp.close(), gateway.controlApp.close()]);
  });

  it("registers a local GGUF through the control route and exposes desktop metadata", async () => {
    const fixture = await createStage2Fixture();
    const gateway = await buildGateway({
      config: createTestConfig(),
      runtime: fixture.runtime,
    });
    const artifactPath = path.join(fixture.appPaths.supportRoot, "models", "gateway-stage2.gguf");

    await writeSampleGgufFile(artifactPath);
    await Promise.all([gateway.publicApp.ready(), gateway.controlApp.ready()]);

    const registerResponse = await gateway.controlApp.inject({
      method: "POST",
      url: "/control/models/register-local",
      headers: {
        authorization: "Bearer control-secret-stage2",
      },
      payload: {
        filePath: artifactPath,
        displayName: "Gateway Tiny Chat",
      },
    });

    expect(registerResponse.statusCode).toBe(201);
    expect(registerResponse.json()).toMatchObject({
      created: true,
      model: expect.objectContaining({
        displayName: "Gateway Tiny Chat",
        localPath: artifactPath,
        format: "gguf",
        contextLength: 8192,
        artifactStatus: "available",
        state: "idle",
      }),
    });

    const desktopModelsResponse = await gateway.controlApp.inject({
      method: "GET",
      url: "/control/models",
      headers: {
        authorization: "Bearer control-secret-stage2",
      },
    });

    expect(desktopModelsResponse.statusCode).toBe(200);
    expect(desktopModelsResponse.json()).toMatchObject({
      object: "list",
      data: expect.arrayContaining([
        expect.objectContaining({
          localPath: artifactPath,
          displayName: "Gateway Tiny Chat",
        }),
      ]),
    });

    await Promise.allSettled([gateway.publicApp.close(), gateway.controlApp.close()]);
  });

  it.runIf(supportsMlxTests)(
    "installs a managed MLX runtime, registers an MLX directory, and serves chat",
    async () => {
      const fixture = await createStage2Fixture();
      const gateway = await buildGateway({
        config: createTestConfig(),
        runtime: fixture.runtime,
      });
      const artifactPath = path.join(fixture.appPaths.supportRoot, "models", "gateway-stage2-mlx");

      await writeSampleMlxModelDirectory(artifactPath);
      await Promise.all([gateway.publicApp.ready(), gateway.controlApp.ready()]);

      const installResponse = await gateway.controlApp.inject({
        method: "POST",
        url: "/control/engines",
        headers: {
          authorization: "Bearer control-secret-stage2",
        },
        payload: {
          engineType: "mlx",
          action: "install-managed-runtime",
          versionTag: "stage2-mlx-runtime",
        },
      });

      expect(installResponse.statusCode).toBe(202);
      expect(installResponse.json()).toMatchObject({
        accepted: true,
        engine: expect.objectContaining({
          engineType: "mlx",
          version: "stage2-mlx-runtime",
          active: true,
        }),
        notes: expect.arrayContaining([expect.stringContaining("fake MLX runtime")]),
      });

      const registerResponse = await gateway.controlApp.inject({
        method: "POST",
        url: "/control/models/register-local",
        headers: {
          authorization: "Bearer control-secret-stage2",
        },
        payload: {
          filePath: artifactPath,
          displayName: "Gateway MLX Chat",
        },
      });

      expect(registerResponse.statusCode).toBe(201);
      expect(registerResponse.json()).toMatchObject({
        created: true,
        model: expect.objectContaining({
          displayName: "Gateway MLX Chat",
          engineType: "mlx",
          format: "mlx",
          localPath: artifactPath,
          architecture: "llama",
          contextLength: 4096,
          parameterCount: 123456789,
          artifactStatus: "available",
          state: "idle",
        }),
      });

      const registeredModel = registerResponse.json().model as {
        id: string;
        batchSize?: number;
        gpuLayers?: number;
        parallelSlots?: number;
        flashAttentionType?: string;
      };
      expect(registeredModel.batchSize).toBeUndefined();
      expect(registeredModel.gpuLayers).toBeUndefined();
      expect(registeredModel.parallelSlots).toBeUndefined();
      expect(registeredModel.flashAttentionType).toBeUndefined();

      const chatResponse = await gateway.publicApp.inject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: {
          authorization: "Bearer public-secret-stage2",
        },
        payload: {
          model: registeredModel.id,
          messages: [{ role: "user", content: "Hello from MLX." }],
        },
      });

      expect(chatResponse.statusCode).toBe(200);
      expect(chatResponse.json()).toMatchObject({
        object: "chat.completion",
        model: registeredModel.id,
        choices: [
          expect.objectContaining({
            finish_reason: "stop",
            message: expect.objectContaining({
              role: "assistant",
            }),
          }),
        ],
      });

      const embeddingsResponse = await gateway.publicApp.inject({
        method: "POST",
        url: "/v1/embeddings",
        headers: {
          authorization: "Bearer public-secret-stage2",
        },
        payload: {
          model: registeredModel.id,
          input: "MLX embeddings should be rejected in the first pass.",
        },
      });

      expect(embeddingsResponse.statusCode).toBe(409);
      expect(embeddingsResponse.json()).toMatchObject({
        error: "unsupported_model_capability",
        message: `Model ${registeredModel.id} does not support embeddings requests.`,
      });

      await Promise.allSettled([gateway.publicApp.close(), gateway.controlApp.close()]);
    },
  );

  it.runIf(supportsMlxTests)(
    "auto-discovers GGUF files and MLX directories from the same local models path",
    async () => {
      const supportRoot = await mkdtemp(path.join(os.tmpdir(), "localhub-gateway-stage2-mixed-"));
      const localModelsDir = path.join(supportRoot, "models");
      const ggufPath = path.join(localModelsDir, "nested", "gateway-stage2-mixed.gguf");
      const mlxPath = path.join(localModelsDir, "gateway-stage2-mixed-mlx");

      await writeSampleGgufFile(ggufPath);
      await writeSampleMlxModelDirectory(mlxPath);

      const runtime = createRepositoryGatewayRuntime({
        cwd: process.cwd(),
        defaultModelTtlMs: 1_000,
        env: {
          ...process.env,
          LOCAL_LLM_HUB_ENV: "test",
        },
        fakeWorkerStartupDelayMs: 25,
        preferFakeWorker: true,
        supportRoot,
        localModelsDir,
        telemetryIntervalMs: 50,
      });
      const fixture = {
        appPaths: resolveAppPaths({
          cwd: process.cwd(),
          environment: "test",
          supportRoot,
        }),
        artifactPaths: {},
        async cleanup() {
          await runtime.stop();
          await rm(supportRoot, { recursive: true, force: true });
        },
        runtime,
      };
      fixtures.push(fixture);

      await runtime.start();

      const gateway = await buildGateway({
        config: createTestConfig({
          localModelsDir,
        }),
        runtime,
      });

      await Promise.all([gateway.publicApp.ready(), gateway.controlApp.ready()]);

      const desktopModelsResponse = await gateway.controlApp.inject({
        method: "GET",
        url: "/control/models",
        headers: {
          authorization: "Bearer control-secret-stage2",
        },
      });

      expect(desktopModelsResponse.statusCode).toBe(200);
      expect(desktopModelsResponse.json()).toMatchObject({
        object: "list",
        data: expect.arrayContaining([
          expect.objectContaining({
            localPath: ggufPath,
            engineType: "llama.cpp",
            format: "gguf",
          }),
          expect.objectContaining({
            localPath: mlxPath,
            engineType: "mlx",
            format: "mlx",
          }),
        ]),
      });

      await Promise.allSettled([gateway.publicApp.close(), gateway.controlApp.close()]);
    },
  );

  it.runIf(supportsMlxTests)(
    "auto-discovers legacy managed MLX downloads when the configured models path differs",
    async () => {
      const supportRoot = await mkdtemp(path.join(os.tmpdir(), "localhub-gateway-stage2-legacy-"));
      const configuredModelsDir = path.join(supportRoot, "external-models");
      const legacyManagedModelsDir = path.join(supportRoot, "models");
      const mlxPath = path.join(legacyManagedModelsDir, "gateway-stage2-legacy-mlx");

      await writeSampleMlxModelDirectory(mlxPath);

      const runtime = createRepositoryGatewayRuntime({
        cwd: process.cwd(),
        defaultModelTtlMs: 1_000,
        env: {
          ...process.env,
          LOCAL_LLM_HUB_ENV: "test",
        },
        fakeWorkerStartupDelayMs: 25,
        preferFakeWorker: true,
        supportRoot,
        localModelsDir: configuredModelsDir,
        telemetryIntervalMs: 50,
      });
      fixtures.push({
        appPaths: resolveAppPaths({
          cwd: process.cwd(),
          environment: "test",
          supportRoot,
        }),
        artifactPaths: {},
        async cleanup() {
          await runtime.stop();
          await rm(supportRoot, { recursive: true, force: true });
        },
        runtime,
      });

      await runtime.start();

      const models = await runtime.listDesktopModels();
      expect(models).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            localPath: mlxPath,
            engineType: "mlx",
            format: "mlx",
          }),
        ]),
      );
    },
  );

  it("imports a local llama.cpp binary through the control route and packages it into support", async () => {
    const fixture = await createStage2Fixture();
    const gateway = await buildGateway({
      config: createTestConfig(),
      runtime: fixture.runtime,
    });
    const sourceBinaryPath = path.join(
      fixture.appPaths.supportRoot,
      "downloads",
      "custom-llama-server",
    );

    await mkdir(path.dirname(sourceBinaryPath), { recursive: true });
    await writeFile(sourceBinaryPath, "#!/bin/sh\nexit 0\n");
    await chmod(sourceBinaryPath, 0o755);
    await Promise.all([gateway.publicApp.ready(), gateway.controlApp.ready()]);

    const installResponse = await gateway.controlApp.inject({
      method: "POST",
      url: "/control/engines",
      headers: {
        authorization: "Bearer control-secret-stage2",
      },
      payload: {
        action: "import-local-binary",
        filePath: sourceBinaryPath,
      },
    });

    const installBody = installResponse.json() as {
      accepted: boolean;
      engine: {
        binaryPath?: string;
        id: string;
        version: string;
      };
      notes: string[];
    };
    const paths = resolveEngineSupportPaths(fixture.appPaths.supportRoot, "llama.cpp");
    const registry = readEngineVersionRegistry(paths.registryFile, "llama.cpp");

    expect(installResponse.statusCode).toBe(202);
    expect(installBody.accepted).toBe(true);
    expect(installBody.engine.binaryPath).toBeDefined();
    expect(installBody.engine.binaryPath).not.toBe(sourceBinaryPath);
    expect(installBody.engine.binaryPath?.startsWith(paths.versionsRoot)).toBe(true);
    expect(installBody.notes).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Imported a local llama.cpp binary"),
        expect.stringContaining("Packaged the binary inside"),
      ]),
    );
    expect(registry.activeVersionTag).toBe(installBody.engine.version);
    expect(registry.versions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          versionTag: installBody.engine.version,
          binaryPath: installBody.engine.binaryPath,
        }),
      ]),
    );

    await Promise.allSettled([gateway.publicApp.close(), gateway.controlApp.close()]);
  });

  it("switches the active llama.cpp version across multiple installed binaries", async () => {
    const fixture = await createStage2Fixture();
    const gateway = await buildGateway({
      config: createTestConfig(),
      runtime: fixture.runtime,
    });
    const sourceBinaryA = path.join(fixture.appPaths.supportRoot, "downloads", "llama-a");
    const sourceBinaryB = path.join(fixture.appPaths.supportRoot, "downloads", "llama-b");

    await mkdir(path.dirname(sourceBinaryA), { recursive: true });
    await writeFile(sourceBinaryA, "#!/bin/sh\nexit 0\n");
    await writeFile(sourceBinaryB, "#!/bin/sh\nexit 0\n");
    await chmod(sourceBinaryA, 0o755);
    await chmod(sourceBinaryB, 0o755);
    await Promise.all([gateway.publicApp.ready(), gateway.controlApp.ready()]);

    const installResponseA = await gateway.controlApp.inject({
      method: "POST",
      url: "/control/engines",
      headers: {
        authorization: "Bearer control-secret-stage2",
      },
      payload: {
        action: "import-local-binary",
        filePath: sourceBinaryA,
        versionTag: "llama-a",
      },
    });

    const installResponseB = await gateway.controlApp.inject({
      method: "POST",
      url: "/control/engines",
      headers: {
        authorization: "Bearer control-secret-stage2",
      },
      payload: {
        action: "import-local-binary",
        filePath: sourceBinaryB,
        versionTag: "llama-b",
      },
    });

    const activateResponse = await gateway.controlApp.inject({
      method: "POST",
      url: "/control/engines",
      headers: {
        authorization: "Bearer control-secret-stage2",
      },
      payload: {
        action: "activate-installed-version",
        versionTag: "llama-a",
      },
    });

    const paths = resolveEngineSupportPaths(fixture.appPaths.supportRoot, "llama.cpp");
    const registry = readEngineVersionRegistry(paths.registryFile, "llama.cpp");
    const enginesResponse = await gateway.controlApp.inject({
      method: "GET",
      url: "/control/engines",
      headers: {
        authorization: "Bearer control-secret-stage2",
      },
    });
    const enginesBody = enginesResponse.json() as {
      data: Array<{
        active: boolean;
        binaryPath?: string;
        version: string;
      }>;
    };

    expect(installResponseA.statusCode).toBe(202);
    expect(installResponseB.statusCode).toBe(202);
    expect(activateResponse.statusCode).toBe(202);
    expect(activateResponse.json()).toMatchObject({
      accepted: true,
      engine: expect.objectContaining({
        version: "llama-a",
        active: true,
      }),
      notes: expect.arrayContaining([
        expect.stringContaining("Activated installed llama.cpp version llama-a"),
      ]),
    });
    expect(registry.activeVersionTag).toBe("llama-a");
    expect(enginesBody.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          version: "llama-a",
          active: true,
          binaryPath: expect.stringContaining(paths.versionsRoot),
        }),
        expect.objectContaining({
          version: "llama-b",
          active: false,
        }),
      ]),
    );

    await Promise.allSettled([gateway.publicApp.close(), gateway.controlApp.close()]);
  });

  it("collapses concurrent cold starts and reuses a warm worker", async () => {
    const fixture = await createStage2Fixture();

    const [first, second] = await Promise.all([
      fixture.runtime.preloadModel(fixtureModelArtifact.id, "trace-preload-a"),
      fixture.runtime.preloadModel(fixtureModelArtifact.id, "trace-preload-b"),
    ]);

    expect(first.alreadyWarm).toBe(false);
    expect(second.alreadyWarm).toBe(false);
    expect(first.model.state).toBe("Ready");
    expect(second.model.state).toBe("Ready");

    const third = await fixture.runtime.preloadModel(fixtureModelArtifact.id, "trace-preload-c");
    expect(third.alreadyWarm).toBe(true);

    const reopened = openDatabase({
      filePath: fixture.appPaths.databaseFile,
      migrationsDir,
    });
    const models = new ModelsRepository(reopened.database);
    const stored = models.findById(fixtureModelArtifact.id);
    reopened.database.close();

    expect(stored?.loadCount).toBe(1);
  });

  it("preloads pooled embedding and rerank models without requiring explicit batch overrides", async () => {
    const fixture = await createStage2Fixture();

    const embeddingLoad = await fixture.runtime.preloadModel(
      embeddingsModelArtifact.id,
      "trace-preload-embedding",
    );
    const rerankLoad = await fixture.runtime.preloadModel(
      rerankModelArtifact.id,
      "trace-preload-rerank",
    );
    const desktopModels = await fixture.runtime.listDesktopModels();
    const embeddingDesktopModel = desktopModels.find(
      (model) => model.id === embeddingsModelArtifact.id,
    );
    const rerankDesktopModel = desktopModels.find((model) => model.id === rerankModelArtifact.id);

    expect(embeddingLoad.alreadyWarm).toBe(false);
    expect(embeddingLoad.model).toMatchObject({
      id: embeddingsModelArtifact.id,
      state: "Ready",
      loaded: true,
    });
    expect(rerankLoad.alreadyWarm).toBe(false);
    expect(rerankLoad.model).toMatchObject({
      id: rerankModelArtifact.id,
      state: "Ready",
      loaded: true,
    });
    expect(embeddingDesktopModel).toMatchObject({
      id: embeddingsModelArtifact.id,
      role: "embeddings",
      batchSize: 512,
      ubatchSize: 512,
    });
    expect(rerankDesktopModel).toMatchObject({
      id: rerankModelArtifact.id,
      role: "rerank",
      batchSize: 512,
      ubatchSize: 512,
    });
  });

  it("preloads and evicts through the control routes with real runtime state", async () => {
    const fixture = await createStage2Fixture();
    const gateway = await buildGateway({
      config: createTestConfig(),
      runtime: fixture.runtime,
    });

    await Promise.all([gateway.publicApp.ready(), gateway.controlApp.ready()]);

    const preloadResponse = await gateway.controlApp.inject({
      method: "POST",
      url: "/control/models/preload",
      headers: {
        authorization: "Bearer control-secret-stage2",
      },
      payload: {
        modelId: fixtureModelArtifact.id,
      },
    });

    expect(preloadResponse.statusCode).toBe(202);
    expect(preloadResponse.json()).toMatchObject({
      accepted: true,
      model: expect.objectContaining({
        id: fixtureModelArtifact.id,
        state: "Ready",
        loaded: true,
      }),
    });

    const runtimeModelsResponse = await gateway.controlApp.inject({
      method: "GET",
      url: "/control/models",
      headers: {
        authorization: "Bearer control-secret-stage2",
      },
    });
    expect(runtimeModelsResponse.statusCode).toBe(200);
    expect(runtimeModelsResponse.json()).toMatchObject({
      data: expect.arrayContaining([
        expect.objectContaining({
          id: fixtureModelArtifact.id,
          state: "ready",
          loaded: true,
        }),
      ]),
    });

    const renameResponse = await gateway.controlApp.inject({
      method: "PUT",
      url: `/config/models/${fixtureModelArtifact.id}`,
      headers: {
        authorization: "Bearer control-secret-stage2",
      },
      payload: {
        displayName: "Gateway Tiny Chat Alias",
      },
    });

    expect(renameResponse.statusCode).toBe(200);
    expect(renameResponse.json()).toMatchObject({
      model: expect.objectContaining({
        id: fixtureModelArtifact.id,
        displayName: "Gateway Tiny Chat Alias",
        loaded: true,
      }),
    });

    const evictResponse = await gateway.controlApp.inject({
      method: "POST",
      url: "/control/models/evict",
      headers: {
        authorization: "Bearer control-secret-stage2",
      },
      payload: {
        modelId: fixtureModelArtifact.id,
      },
    });

    expect(evictResponse.statusCode).toBe(202);
    expect(evictResponse.json()).toMatchObject({
      accepted: true,
      model: expect.objectContaining({
        id: fixtureModelArtifact.id,
        state: "Idle",
        loaded: false,
      }),
    });

    await Promise.allSettled([gateway.publicApp.close(), gateway.controlApp.close()]);
  });

  it("opens a worker circuit breaker after repeated load failures", async () => {
    const fixture = await createStage2Fixture({
      runtimeOverrides: {
        failureBackoffMs: 50,
        failureBackoffMaxMs: 50,
        failureWindowMs: 500,
        circuitBreakerThreshold: 2,
        circuitBreakerCooldownMs: 1_000,
      },
    });

    await rm(fixture.artifactPaths[fixtureModelArtifact.id] ?? "", { force: true });

    await expect(
      fixture.runtime.preloadModel(fixtureModelArtifact.id, "trace-fail-1"),
    ).rejects.toThrow(/Local artifact is missing/);
    await expect(
      fixture.runtime.preloadModel(fixtureModelArtifact.id, "trace-fail-2"),
    ).rejects.toMatchObject({
      code: "worker_circuit_open",
    } satisfies Partial<GatewayRequestError>);
  });

  it("evicts the least recently used idle worker under resident memory pressure", async () => {
    const fixture = await createStage2Fixture({
      extraSeedModels: [
        {
          artifact: secondaryChatModelArtifact,
          profile: secondaryChatModelProfile,
          fileName: "fixture-qwen25-chat-secondary.gguf",
        },
      ],
      runtimeOverrides: {
        maxResidentMemoryBytes: fixtureModelArtifact.sizeBytes + 1,
      },
    });

    await fixture.runtime.preloadModel(fixtureModelArtifact.id, "trace-lru-1");
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    await fixture.runtime.preloadModel(secondaryChatModelArtifact.id, "trace-lru-2");

    const runtimeModels = fixture.runtime.listRuntimeModels();
    expect(runtimeModels.find((model) => model.id === fixtureModelArtifact.id)?.loaded).toBe(false);
    expect(runtimeModels.find((model) => model.id === secondaryChatModelArtifact.id)?.loaded).toBe(
      true,
    );
  });

  it("evicts the least recently used idle model when the active model limit is reached", async () => {
    const fixture = await createStage2Fixture({
      extraSeedModels: [
        {
          artifact: secondaryChatModelArtifact,
          profile: secondaryChatModelProfile,
          fileName: "fixture-qwen25-chat-secondary.gguf",
        },
      ],
      runtimeOverrides: {
        maxActiveModelsInMemory: 1,
      },
    });

    await fixture.runtime.preloadModel(fixtureModelArtifact.id, "trace-model-cap-1");
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    await fixture.runtime.preloadModel(secondaryChatModelArtifact.id, "trace-model-cap-2");

    const runtimeModels = fixture.runtime.listRuntimeModels();
    expect(runtimeModels.find((model) => model.id === fixtureModelArtifact.id)?.loaded).toBe(false);
    expect(runtimeModels.find((model) => model.id === secondaryChatModelArtifact.id)?.loaded).toBe(
      true,
    );
  });

  it("rejects new work once shutdown draining begins", async () => {
    const fixture = await createStage2Fixture({
      runtimeOverrides: {
        fakeWorkerStartupDelayMs: 250,
        shutdownDrainTimeoutMs: 50,
      },
    });

    const preloadPromise = fixture.runtime
      .preloadModel(fixtureModelArtifact.id, "trace-shutdown")
      .catch((error: unknown) => error);
    const stopPromise = fixture.runtime.stop();
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });

    let error: unknown;
    try {
      await fixture.runtime.createDownload({
        provider: "huggingface",
        providerModelId: "acme/stage4-chat",
        artifactId: "stage4-chat-q4",
        title: "Stage4 Chat",
        artifactName: "stage4-chat-q4.gguf",
        downloadUrl: "https://example.invalid/stage4-chat-q4.gguf",
        metadata: {},
      });
    } catch (reason) {
      error = reason;
    }

    await Promise.allSettled([preloadPromise, stopPromise]);

    expect(error).toBeInstanceOf(GatewayRequestError);
    expect((error as GatewayRequestError).code).toBe("gateway_stopping");
  });

  it("fails preload before worker startup when a registered artifact has gone missing", async () => {
    const fixture = await createStage2Fixture();
    const gateway = await buildGateway({
      config: createTestConfig(),
      runtime: fixture.runtime,
    });
    const artifactPath = path.join(fixture.appPaths.modelsDir, "missing-after-register.gguf");

    await writeSampleGgufFile(artifactPath);
    await Promise.all([gateway.publicApp.ready(), gateway.controlApp.ready()]);

    const registerResponse = await gateway.controlApp.inject({
      method: "POST",
      url: "/control/models/register-local",
      headers: {
        authorization: "Bearer control-secret-stage2",
      },
      payload: {
        filePath: artifactPath,
        displayName: "Missing After Register",
      },
    });

    expect(registerResponse.statusCode).toBe(201);
    const registeredModelId = registerResponse.json().model.id as string;

    await rm(artifactPath, { force: true });

    const preloadResponse = await gateway.controlApp.inject({
      method: "POST",
      url: "/control/models/preload",
      headers: {
        authorization: "Bearer control-secret-stage2",
      },
      payload: {
        modelId: registeredModelId,
      },
    });

    expect(preloadResponse.statusCode).toBe(409);
    expect(preloadResponse.json()).toMatchObject({
      error: "model_load_failed",
      message: `Local artifact is missing from ${artifactPath}.`,
    });

    const desktopModels = await fixture.runtime.listDesktopModels();
    expect(desktopModels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: registeredModelId,
          artifactStatus: "missing",
          loaded: false,
        }),
      ]),
    );

    await Promise.allSettled([gateway.publicApp.close(), gateway.controlApp.close()]);
  });

  it("deletes a registered model while keeping its artifact on disk when requested", async () => {
    const fixture = await createStage2Fixture();
    const gateway = await buildGateway({
      config: createTestConfig(),
      runtime: fixture.runtime,
    });
    const artifactPath = fixture.artifactPaths[fixtureModelArtifact.id];

    await Promise.all([gateway.publicApp.ready(), gateway.controlApp.ready()]);

    const deleteResponse = await gateway.controlApp.inject({
      method: "DELETE",
      url: `/control/models/${encodeURIComponent(fixtureModelArtifact.id)}`,
      headers: {
        authorization: "Bearer control-secret-stage2",
      },
      payload: {
        deleteFiles: false,
      },
    });

    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json()).toMatchObject({
      accepted: true,
      id: fixtureModelArtifact.id,
      deletedFiles: false,
      deletedPaths: [],
    });

    const desktopModels = await fixture.runtime.listDesktopModels();
    expect(desktopModels.map((model) => model.id)).not.toContain(fixtureModelArtifact.id);
    expect(existsSync(artifactPath)).toBe(true);

    await Promise.allSettled([gateway.publicApp.close(), gateway.controlApp.close()]);
  });

  it("deletes a registered model and removes related files when requested", async () => {
    const fixture = await createStage2Fixture();
    const gateway = await buildGateway({
      config: createTestConfig(),
      runtime: fixture.runtime,
    });
    const artifactPath = path.join(fixture.appPaths.modelsDir, "delete-me.gguf");
    const mmprojPath = path.join(fixture.appPaths.modelsDir, "mmproj-delete-me.gguf");

    await writeSampleGgufFile(artifactPath);
    await writeSampleGgufFile(mmprojPath);
    await Promise.all([gateway.publicApp.ready(), gateway.controlApp.ready()]);

    const registerResponse = await gateway.controlApp.inject({
      method: "POST",
      url: "/control/models/register-local",
      headers: {
        authorization: "Bearer control-secret-stage2",
      },
      payload: {
        filePath: artifactPath,
        displayName: "Delete Me",
      },
    });

    expect(registerResponse.statusCode).toBe(201);
    const registeredModelId = registerResponse.json().model.id as string;

    const deleteResponse = await gateway.controlApp.inject({
      method: "DELETE",
      url: `/control/models/${encodeURIComponent(registeredModelId)}`,
      headers: {
        authorization: "Bearer control-secret-stage2",
      },
      payload: {
        deleteFiles: true,
      },
    });

    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json()).toMatchObject({
      accepted: true,
      id: registeredModelId,
      deletedFiles: true,
      deletedPaths: expect.arrayContaining([artifactPath, mmprojPath]),
    });

    const desktopModels = await fixture.runtime.listDesktopModels();
    expect(desktopModels.map((model) => model.id)).not.toContain(registeredModelId);
    expect(existsSync(artifactPath)).toBe(false);
    expect(existsSync(mmprojPath)).toBe(false);

    await Promise.allSettled([gateway.publicApp.close(), gateway.controlApp.close()]);
  });

  it("auto-cleans missing model registrations on startup", async () => {
    const fixture = await createStage2Fixture();
    const supportRoot = fixture.appPaths.supportRoot;
    const missingArtifactPath = fixture.artifactPaths[fixtureModelArtifact.id];

    await rm(missingArtifactPath, { force: true });
    await fixture.runtime.stop();

    const restartedRuntime = createRepositoryGatewayRuntime({
      cwd: process.cwd(),
      defaultModelTtlMs: 1_000,
      env: {
        ...process.env,
        LOCAL_LLM_HUB_ENV: "test",
      },
      fakeWorkerStartupDelayMs: 25,
      preferFakeWorker: true,
      supportRoot,
      localModelsDir: path.join(supportRoot, "models"),
      telemetryIntervalMs: 50,
    });
    await restartedRuntime.start();

    fixture.runtime = restartedRuntime;
    fixture.cleanup = async () => {
      await restartedRuntime.stop();
      await rm(supportRoot, { recursive: true, force: true });
    };

    const desktopModels = await restartedRuntime.listDesktopModels();
    expect(desktopModels.map((model) => model.id)).not.toContain(fixtureModelArtifact.id);
    expect(desktopModels.map((model) => model.id)).toEqual(
      expect.arrayContaining([embeddingsModelArtifact.id, rerankModelArtifact.id]),
    );
  });

  it("removes superseded llama.cpp release installs during startup cleanup", async () => {
    const fixture = await createStage2Fixture();
    const supportRoot = fixture.appPaths.supportRoot;
    const currentPaths = resolveEngineSupportPaths(supportRoot, "llama.cpp");
    const legacySupportRoot = path.join(path.dirname(supportRoot), "legacy-support");
    const oldVersionTag = "release-b8663-darwin-arm64";
    const newVersionTag = "release-b8840-darwin-arm64";
    const currentOldInstallRoot = path.join(currentPaths.versionsRoot, oldVersionTag);
    const currentNewInstallRoot = path.join(currentPaths.versionsRoot, newVersionTag);
    const currentOldBinaryPath = path.join(currentOldInstallRoot, "llama-b8663", "llama-server");
    const currentNewBinaryPath = path.join(currentNewInstallRoot, "llama-b8840", "llama-server");
    const legacyOldInstallRoot = path.join(
      legacySupportRoot,
      "engines",
      "llama.cpp",
      "versions",
      oldVersionTag,
    );
    const legacyOldBinaryPath = path.join(legacyOldInstallRoot, "llama-b8663", "llama-server");

    await fixture.runtime.stop();
    await mkdir(path.dirname(currentOldBinaryPath), { recursive: true });
    await mkdir(path.dirname(currentNewBinaryPath), { recursive: true });
    await mkdir(path.dirname(legacyOldBinaryPath), { recursive: true });
    await writeFile(currentOldBinaryPath, "#!/bin/sh\nexit 0\n");
    await writeFile(currentNewBinaryPath, "#!/bin/sh\nexit 0\n");
    await writeFile(legacyOldBinaryPath, "#!/bin/sh\nexit 0\n");

    writeEngineVersionRegistry(currentPaths.registryFile, {
      engineType: "llama.cpp",
      activeVersionTag: newVersionTag,
      versions: [
        {
          versionTag: oldVersionTag,
          installPath: currentOldInstallRoot,
          binaryPath: currentOldBinaryPath,
          source: "release",
          channel: "stable",
          managedBy: "binary",
          installedAt: "2026-04-18T12:00:00.000Z",
          notes: ["Downloaded llama.cpp release b8663."],
        },
        {
          versionTag: newVersionTag,
          installPath: currentNewInstallRoot,
          binaryPath: currentNewBinaryPath,
          source: "release",
          channel: "stable",
          managedBy: "binary",
          installedAt: "2026-04-19T12:00:00.000Z",
          notes: ["Downloaded llama.cpp release b8840."],
        },
      ],
      updatedAt: "2026-04-19T12:00:00.000Z",
    });

    const seeded = openDatabase({
      filePath: fixture.appPaths.databaseFile,
      migrationsDir,
    });
    const engines = new EngineVersionsRepository(seeded.database);
    engines.upsert({
      ...fixtureEngineVersion,
      id: "engine_llamacpp_old_current",
      versionTag: oldVersionTag,
      binaryPath: currentOldBinaryPath,
      isActive: false,
      installedAt: "2026-04-18T12:00:00.000Z",
    });
    engines.upsert({
      ...fixtureEngineVersion,
      id: "engine_llamacpp_old_legacy",
      versionTag: oldVersionTag,
      binaryPath: legacyOldBinaryPath,
      isActive: false,
      installedAt: "2026-04-08T12:00:00.000Z",
    });
    engines.upsert({
      ...fixtureEngineVersion,
      id: "engine_llamacpp_new_current",
      versionTag: newVersionTag,
      binaryPath: currentNewBinaryPath,
      isActive: true,
      installedAt: "2026-04-19T12:00:00.000Z",
    });
    seeded.database.close();

    const restartedRuntime = createRepositoryGatewayRuntime({
      cwd: process.cwd(),
      defaultModelTtlMs: 1_000,
      env: {
        ...process.env,
        LOCAL_LLM_HUB_ENV: "test",
      },
      fakeWorkerStartupDelayMs: 25,
      preferFakeWorker: true,
      supportRoot,
      localModelsDir: path.join(supportRoot, "models"),
      telemetryIntervalMs: 50,
    });
    await restartedRuntime.start();

    fixture.runtime = restartedRuntime;
    fixture.cleanup = async () => {
      await restartedRuntime.stop();
      await rm(supportRoot, { recursive: true, force: true });
      await rm(legacySupportRoot, { recursive: true, force: true });
    };

    const registry = readEngineVersionRegistry(currentPaths.registryFile, "llama.cpp");
    const reopened = openDatabase({
      filePath: fixture.appPaths.databaseFile,
      migrationsDir,
    });
    const storedEngines = new EngineVersionsRepository(reopened.database).list();
    reopened.database.close();

    expect(registry.activeVersionTag).toBe(newVersionTag);
    expect(registry.versions).toEqual([
      expect.objectContaining({
        versionTag: newVersionTag,
        binaryPath: currentNewBinaryPath,
      }),
    ]);
    expect(storedEngines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          versionTag: newVersionTag,
          binaryPath: currentNewBinaryPath,
          isActive: true,
        }),
      ]),
    );
    expect(storedEngines.find((record) => record.versionTag === oldVersionTag)).toBeUndefined();
    expect(restartedRuntime.listEngines().find((record) => record.version === oldVersionTag)).toBeUndefined();
    expect(existsSync(currentOldInstallRoot)).toBe(false);
    expect(existsSync(legacyOldInstallRoot)).toBe(false);
    expect(existsSync(currentNewInstallRoot)).toBe(true);
  });

  it("refreshes stored GGUF metadata from companion sidecars on startup", async () => {
    const fixture = await createStage2Fixture();
    const supportRoot = fixture.appPaths.supportRoot;
    const artifactPath = fixture.artifactPaths[fixtureModelArtifact.id];
    const artifactDirectory = path.dirname(artifactPath);

    await writeFile(
      path.join(artifactDirectory, "config.json"),
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
      path.join(artifactDirectory, "tokenizer_config.json"),
      `${JSON.stringify(
        {
          tokenizer_class: "Qwen2TokenizerFast",
        },
        null,
        2,
      )}\n`,
    );

    await fixture.runtime.stop();

    const restartedRuntime = createRepositoryGatewayRuntime({
      cwd: process.cwd(),
      defaultModelTtlMs: 1_000,
      env: {
        ...process.env,
        LOCAL_LLM_HUB_ENV: "test",
      },
      fakeWorkerStartupDelayMs: 25,
      preferFakeWorker: true,
      supportRoot,
      localModelsDir: path.join(supportRoot, "models"),
      telemetryIntervalMs: 50,
    });
    await restartedRuntime.start();

    fixture.runtime = restartedRuntime;
    fixture.cleanup = async () => {
      await restartedRuntime.stop();
      await rm(supportRoot, { recursive: true, force: true });
    };

    const refreshed = (await restartedRuntime.listDesktopModels()).find(
      (model) => model.id === fixtureModelArtifact.id,
    );

    expect(refreshed).toMatchObject({
      id: fixtureModelArtifact.id,
      architecture: "qwen3_moe",
      contextLength: 262144,
      parameterCount: 35_000_000_000,
      tokenizer: "Qwen2TokenizerFast",
    });
  });

  it.runIf(supportsMlxTests)(
    "fails preload before worker startup when a registered MLX directory is incomplete",
    async () => {
      const fixture = await createStage2Fixture();
      const gateway = await buildGateway({
        config: createTestConfig(),
        runtime: fixture.runtime,
      });
      const artifactPath = path.join(
        fixture.appPaths.supportRoot,
        "models",
        "missing-mlx-files-after-register",
      );

      await writeSampleMlxModelDirectory(artifactPath);
      await Promise.all([gateway.publicApp.ready(), gateway.controlApp.ready()]);

      const registerResponse = await gateway.controlApp.inject({
        method: "POST",
        url: "/control/models/register-local",
        headers: {
          authorization: "Bearer control-secret-stage2",
        },
        payload: {
          filePath: artifactPath,
          displayName: "Missing MLX Files After Register",
        },
      });

      expect(registerResponse.statusCode).toBe(201);
      const registeredModelId = registerResponse.json().model.id as string;

      await rm(path.join(artifactPath, "config.json"), { force: true });

      const preloadResponse = await gateway.controlApp.inject({
        method: "POST",
        url: "/control/models/preload",
        headers: {
          authorization: "Bearer control-secret-stage2",
        },
        payload: {
          modelId: registeredModelId,
        },
      });

      expect(preloadResponse.statusCode).toBe(409);
      expect(preloadResponse.json()).toMatchObject({
        error: "model_load_failed",
        message: `MLX model directory is incomplete at ${artifactPath}. Re-download the MLX bundle to restore missing files.`,
      });

      const desktopModels = await fixture.runtime.listDesktopModels();
      expect(desktopModels).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: registeredModelId,
            artifactStatus: "missing",
            loaded: false,
          }),
        ]),
      );

      await Promise.allSettled([gateway.publicApp.close(), gateway.controlApp.close()]);
    },
  );

  it("emits shared lifecycle events in load and evict order", async () => {
    const fixture = await createStage2Fixture();
    const gateway = await buildGateway({
      config: createTestConfig(),
      runtime: fixture.runtime,
    });

    await Promise.all([gateway.publicApp.ready(), gateway.controlApp.ready()]);

    const events: Array<{ type: string; nextState?: string; route?: string }> = [];
    const unsubscribe = fixture.runtime.subscribe((event) => {
      if (event.type === "MODEL_STATE_CHANGED") {
        events.push({
          type: event.type,
          nextState: event.payload.nextState,
        });
      }

      if (event.type === "REQUEST_TRACE") {
        events.push({
          type: event.type,
          route: event.payload.route,
        });
      }
    });

    await gateway.controlApp.inject({
      method: "POST",
      url: "/control/models/preload",
      headers: {
        authorization: "Bearer control-secret-stage2",
      },
      payload: {
        modelId: fixtureModelArtifact.id,
      },
    });

    await gateway.controlApp.inject({
      method: "POST",
      url: "/control/models/evict",
      headers: {
        authorization: "Bearer control-secret-stage2",
      },
      payload: {
        modelId: fixtureModelArtifact.id,
      },
    });

    unsubscribe();

    expect(events).toEqual(
      expect.arrayContaining([
        { type: "MODEL_STATE_CHANGED", nextState: "Loading" },
        { type: "MODEL_STATE_CHANGED", nextState: "Ready" },
        { type: "MODEL_STATE_CHANGED", nextState: "Unloading" },
        { type: "MODEL_STATE_CHANGED", nextState: "CoolingDown" },
        { type: "REQUEST_TRACE", route: "POST /control/models/preload" },
        { type: "REQUEST_TRACE", route: "POST /control/models/evict" },
      ]),
    );

    await Promise.allSettled([gateway.publicApp.close(), gateway.controlApp.close()]);
  });

  it("serves non-streaming chat completions and persists api logs", async () => {
    const fixture = await createStage2Fixture();
    const gateway = await buildGateway({
      config: createTestConfig(),
      runtime: fixture.runtime,
    });

    await Promise.all([gateway.publicApp.ready(), gateway.controlApp.ready()]);

    const response = await gateway.publicApp.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: "Bearer public-secret-stage2",
      },
      payload: {
        model: fixtureModelArtifact.id,
        messages: [{ role: "user", content: "Explain the gateway stage." }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      object: "chat.completion",
      model: fixtureModelArtifact.id,
      choices: [
        expect.objectContaining({
          finish_reason: "stop",
          message: expect.objectContaining({
            role: "assistant",
          }),
        }),
      ],
      usage: expect.objectContaining({
        prompt_tokens: expect.any(Number),
        completion_tokens: expect.any(Number),
      }),
    });

    const reopened = openDatabase({
      filePath: fixture.appPaths.databaseFile,
      migrationsDir,
    });
    const chat = new ChatRepository(reopened.database);
    const logs = chat.listRecentApiLogs();
    reopened.database.close();

    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          endpoint: "/v1/chat/completions",
          modelId: fixtureModelArtifact.id,
          statusCode: 200,
          completionTokens: expect.any(Number),
          tokensPerSecond: expect.any(Number),
        }),
      ]),
    );

    await Promise.allSettled([gateway.publicApp.close(), gateway.controlApp.close()]);
  });

  it("reuses an existing engine row when chat resolves the same binary path", async () => {
    const fixture = await createStage2Fixture();
    const seeded = openDatabase({
      filePath: fixture.appPaths.databaseFile,
      migrationsDir,
    });
    const engines = new EngineVersionsRepository(seeded.database);
    engines.upsert({
      ...fixtureEngineVersion,
      id: "engine_llamacpp_legacy_fake_worker",
      versionTag: "legacy-fake-worker",
      binaryPath: process.execPath,
      isActive: false,
      installedAt: "2026-03-30T12:00:00.000Z",
    });
    seeded.database.close();

    const gateway = await buildGateway({
      config: createTestConfig(),
      runtime: fixture.runtime,
    });

    await Promise.all([gateway.publicApp.ready(), gateway.controlApp.ready()]);

    const response = await gateway.publicApp.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: "Bearer public-secret-stage2",
      },
      payload: {
        model: fixtureModelArtifact.id,
        messages: [{ role: "user", content: "Explain the gateway stage." }],
      },
    });

    expect(response.statusCode).toBe(200);

    const reopened = openDatabase({
      filePath: fixture.appPaths.databaseFile,
      migrationsDir,
    });
    const storedEngines = new EngineVersionsRepository(reopened.database).list();
    reopened.database.close();

    expect(storedEngines).toEqual([
      expect.objectContaining({
        binaryPath: process.execPath,
        versionTag: "stage1-fixture",
        isActive: true,
      }),
    ]);

    await Promise.allSettled([gateway.publicApp.close(), gateway.controlApp.close()]);
  });

  it("streams chat completions with SSE framing and done sentinel", async () => {
    const fixture = await createStage2Fixture();
    const gateway = await buildGateway({
      config: createTestConfig(),
      runtime: fixture.runtime,
    });

    await Promise.all([gateway.publicApp.ready(), gateway.controlApp.ready()]);

    const response = await gateway.publicApp.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: "Bearer public-secret-stage2",
      },
      payload: {
        model: fixtureModelArtifact.id,
        stream: true,
        messages: [{ role: "user", content: "Stream a reply." }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain("data: ");
    expect(response.body).toContain("data: [DONE]");

    await Promise.allSettled([gateway.publicApp.close(), gateway.controlApp.close()]);
  });

  it("counts reasoning text in streamed chat api logs", async () => {
    const fixture = await createStage2Fixture();
    const runtime = fixture.runtime as unknown as {
      fetchWorkerResponse: (
        worker: unknown,
        endpoint: string,
        payload: { messages?: Array<{ content?: unknown }> },
      ) => Promise<Response>;
    };

    runtime.fetchWorkerResponse = async (_worker, endpoint) => {
      if (endpoint !== "/v1/chat/completions") {
        throw new Error(`Unexpected endpoint: ${endpoint}`);
      }

      return createReasoningChatStreamResponse(fixtureModelArtifact.id);
    };

    const gateway = await buildGateway({
      config: createTestConfig(),
      runtime: fixture.runtime,
    });

    await Promise.all([gateway.publicApp.ready(), gateway.controlApp.ready()]);

    const response = await gateway.publicApp.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: "Bearer public-secret-stage2",
      },
      payload: {
        model: fixtureModelArtifact.id,
        stream: true,
        messages: [{ role: "user", content: "Explain your reasoning." }],
      },
    });

    expect(response.statusCode).toBe(200);

    const reopened = openDatabase({
      filePath: fixture.appPaths.databaseFile,
      migrationsDir,
    });
    const chat = new ChatRepository(reopened.database);
    const log = chat
      .listRecentApiLogs()
      .find(
        (entry) =>
          entry.endpoint === "/v1/chat/completions" && entry.modelId === fixtureModelArtifact.id,
      );
    reopened.database.close();

    expect(log).toEqual(
      expect.objectContaining({
        completionTokens: 17,
      }),
    );
    expect(log?.tokensPerSecond).toBeGreaterThan(0);

    await Promise.allSettled([gateway.publicApp.close(), gateway.controlApp.close()]);
  });

  it("reuses a busy worker for concurrent chat requests", async () => {
    const fixture = await createStage2Fixture({
      runtimeOverrides: {
        maxWorkersPerModel: 2,
      },
    });
    const runtime = fixture.runtime as unknown as {
      fetchWorkerResponse: (
        worker: unknown,
        endpoint: string,
        payload: { messages?: Array<{ content?: unknown }> },
      ) => Promise<Response>;
    };

    let loadWorkerCalls = 0;
    const runtimeAny = fixture.runtime as unknown as {
      loadWorker: (...args: unknown[]) => Promise<unknown>;
    };
    const originalLoadWorker = runtimeAny.loadWorker.bind(fixture.runtime);
    runtimeAny.loadWorker = async (...args: unknown[]) => {
      loadWorkerCalls += 1;
      return originalLoadWorker(...args);
    };

    runtime.fetchWorkerResponse = async (_worker, endpoint, payload) => {
      if (endpoint !== "/v1/chat/completions") {
        throw new Error(`Unexpected endpoint: ${endpoint}`);
      }

      const messageText = String(payload.messages?.[0]?.content ?? "");
      const delayMs = messageText.includes("first") ? 600 : 75;
      return createDelayedChatResponse(fixtureModelArtifact.id, messageText, delayMs);
    };

    const gateway = await buildGateway({
      config: createTestConfig(),
      runtime: fixture.runtime,
    });

    await Promise.all([gateway.publicApp.ready(), gateway.controlApp.ready()]);

    let firstCompleted = false;
    const firstRequest = gateway.publicApp.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: "Bearer public-secret-stage2",
      },
      payload: {
        model: fixtureModelArtifact.id,
        messages: [{ role: "user", content: "first request" }],
      },
    });
    firstRequest.then(() => {
      firstCompleted = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    const secondResponse = await gateway.publicApp.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: "Bearer public-secret-stage2",
      },
      payload: {
        model: fixtureModelArtifact.id,
        messages: [{ role: "user", content: "second request" }],
      },
    });

    expect(secondResponse.statusCode).toBe(200);
    expect(firstCompleted).toBe(false);
    expect(loadWorkerCalls).toBe(1);

    const firstResponse = await firstRequest;
    expect(firstResponse.statusCode).toBe(200);
    expect(firstCompleted).toBe(true);

    await Promise.allSettled([gateway.publicApp.close(), gateway.controlApp.close()]);
  });

  it("queues chat requests that arrive after the per-model worker limit", async () => {
    const fixture = await createStage2Fixture({
      runtimeOverrides: {
        maxWorkersPerModel: 2,
      },
    });
    const runtime = fixture.runtime as unknown as {
      fetchWorkerResponse: (
        worker: unknown,
        endpoint: string,
        payload: { messages?: Array<{ content?: unknown }> },
      ) => Promise<Response>;
    };

    runtime.fetchWorkerResponse = async (_worker, endpoint, payload) => {
      if (endpoint !== "/v1/chat/completions") {
        throw new Error(`Unexpected endpoint: ${endpoint}`);
      }

      const messageText = String(payload.messages?.[0]?.content ?? "");
      const delayMs = messageText.includes("third") ? 75 : 600;
      return createDelayedChatResponse(fixtureModelArtifact.id, messageText, delayMs);
    };

    const gateway = await buildGateway({
      config: createTestConfig(),
      runtime: fixture.runtime,
    });

    await Promise.all([gateway.publicApp.ready(), gateway.controlApp.ready()]);

    const firstRequest = gateway.publicApp.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: "Bearer public-secret-stage2",
      },
      payload: {
        model: fixtureModelArtifact.id,
        messages: [{ role: "user", content: "first request" }],
      },
    });

    const secondRequest = gateway.publicApp.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: "Bearer public-secret-stage2",
      },
      payload: {
        model: fixtureModelArtifact.id,
        messages: [{ role: "user", content: "second request" }],
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    const thirdRequest = gateway.publicApp.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: "Bearer public-secret-stage2",
      },
      payload: {
        model: fixtureModelArtifact.id,
        messages: [{ role: "user", content: "third request" }],
      },
    });

    const thirdEarlyResult = await Promise.race([
      thirdRequest.then(() => "resolved" as const),
      new Promise<"pending">((resolve) => {
        setTimeout(() => resolve("pending"), 100);
      }),
    ]);
    expect(thirdEarlyResult).toBe("pending");

    const [firstResponse, secondResponse, thirdResponse] = await Promise.all([
      firstRequest,
      secondRequest,
      thirdRequest,
    ]);

    expect(firstResponse.statusCode).toBe(200);
    expect(secondResponse.statusCode).toBe(200);
    expect(thirdResponse.statusCode).toBe(200);

    await Promise.allSettled([gateway.publicApp.close(), gateway.controlApp.close()]);
  });

  it("passes tool calls through without executing them", async () => {
    const fixture = await createStage2Fixture();
    const gateway = await buildGateway({
      config: createTestConfig(),
      runtime: fixture.runtime,
    });

    await Promise.all([gateway.publicApp.ready(), gateway.controlApp.ready()]);

    const response = await gateway.publicApp.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: "Bearer public-secret-stage2",
      },
      payload: {
        model: fixtureModelArtifact.id,
        messages: [{ role: "user", content: "Use a tool for this." }],
        tools: [
          {
            type: "function",
            function: {
              name: "lookup_weather",
              parameters: { type: "object" },
            },
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      choices: [
        expect.objectContaining({
          finish_reason: "tool_calls",
          message: expect.objectContaining({
            role: "assistant",
            tool_calls: [
              expect.objectContaining({
                function: expect.objectContaining({
                  name: "lookup_weather",
                }),
              }),
            ],
          }),
        }),
      ],
    });

    await Promise.allSettled([gateway.publicApp.close(), gateway.controlApp.close()]);
  });

  it("serves embeddings through the public api for embedding-capable models", async () => {
    const fixture = await createStage2Fixture();
    const gateway = await buildGateway({
      config: createTestConfig(),
      runtime: fixture.runtime,
    });

    await Promise.all([gateway.publicApp.ready(), gateway.controlApp.ready()]);

    const response = await gateway.publicApp.inject({
      method: "POST",
      url: "/v1/embeddings",
      headers: {
        authorization: "Bearer public-secret-stage2",
      },
      payload: {
        model: embeddingsModelArtifact.id,
        input: ["hello", "world"],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      object: "list",
      model: embeddingsModelArtifact.id,
      data: [
        expect.objectContaining({
          object: "embedding",
          index: 0,
          embedding: expect.any(Array),
        }),
        expect.objectContaining({
          object: "embedding",
          index: 1,
          embedding: expect.any(Array),
        }),
      ],
    });

    await Promise.allSettled([gateway.publicApp.close(), gateway.controlApp.close()]);
  });

  it("serves rerank through the public api for rerank-capable models", async () => {
    const fixture = await createStage2Fixture();
    const gateway = await buildGateway({
      config: createTestConfig(),
      runtime: fixture.runtime,
    });

    await Promise.all([gateway.publicApp.ready(), gateway.controlApp.ready()]);

    const response = await gateway.publicApp.inject({
      method: "POST",
      url: "/v1/rerank",
      headers: {
        authorization: "Bearer public-secret-stage2",
      },
      payload: {
        model: rerankModelArtifact.id,
        query: "Which section explains interconnect responsibilities?",
        documents: [
          "Snoop transactions use the snoop address, snoop response, and snoop data channels.",
          "The interconnect receives transactions, issues snoop transactions, and generates the response for the initiating master.",
          "ReadNoSnoop is used in a region of memory that is not Shareable with other masters.",
        ],
        top_n: 2,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      object: "list",
      model: rerankModelArtifact.id,
      results: [
        expect.objectContaining({
          index: 1,
          relevance_score: expect.any(Number),
        }),
        expect.objectContaining({
          relevance_score: expect.any(Number),
        }),
      ],
    });

    await Promise.allSettled([gateway.publicApp.close(), gateway.controlApp.close()]);
  });

  it("accepts the public embedding model name and persists api logs against the canonical model id", async () => {
    const fixture = await createStage2Fixture();
    const gateway = await buildGateway({
      config: createTestConfig(),
      runtime: fixture.runtime,
    });

    await Promise.all([gateway.publicApp.ready(), gateway.controlApp.ready()]);

    const response = await gateway.publicApp.inject({
      method: "POST",
      url: "/v1/embeddings",
      headers: {
        authorization: "Bearer public-secret-stage2",
      },
      payload: {
        model: embeddingsModelProfile.displayName,
        input: "hello world",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      object: "list",
      model: embeddingsModelProfile.displayName,
      data: [
        expect.objectContaining({
          object: "embedding",
          index: 0,
          embedding: expect.any(Array),
        }),
      ],
    });

    const reopened = openDatabase({
      filePath: fixture.appPaths.databaseFile,
      migrationsDir,
    });
    const chat = new ChatRepository(reopened.database);
    const logs = chat.listRecentApiLogs();
    reopened.database.close();

    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          endpoint: "/v1/embeddings",
          modelId: embeddingsModelArtifact.id,
          statusCode: 200,
        }),
      ]),
    );

    await Promise.allSettled([gateway.publicApp.close(), gateway.controlApp.close()]);
  });
});
