import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  ModelsRepository,
  fixtureModelArtifact,
  fixtureModelProfile,
  openDatabase,
} from "@localhub/db";
import { resolveAppPaths } from "@localhub/platform";
import { afterEach, describe, expect, it } from "vitest";

import type { GatewayConfig } from "../src/config.js";
import { createRepositoryGatewayRuntime } from "../src/runtime/repositoryRuntime.js";
import { buildGateway } from "../src/server/app.js";

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

interface Stage2Fixture {
  appPaths: ReturnType<typeof resolveAppPaths>;
  cleanup: () => Promise<void>;
  runtime: ReturnType<typeof createRepositoryGatewayRuntime>;
}

const fixtures: Stage2Fixture[] = [];

function createTestConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    defaultModelTtlMs: 1_000,
    publicHost: "127.0.0.1",
    publicPort: 11434,
    controlHost: "127.0.0.1",
    controlPort: 11435,
    publicBearerToken: "public-secret-stage2",
    controlBearerToken: "control-secret-stage2",
    corsAllowlist: ["localhost", "127.0.0.1"],
    telemetryIntervalMs: 50,
    ...overrides,
  };
}

async function createStage2Fixture(): Promise<Stage2Fixture> {
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

  await writeSampleGgufFile(seededArtifactPath);

  models.save(
    {
      ...fixtureModelArtifact,
      localPath: seededArtifactPath,
    },
    fixtureModelProfile,
  );
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
    telemetryIntervalMs: 50,
  });
  await runtime.start();

  const fixture = {
    appPaths,
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
      data: [
        expect.objectContaining({
          id: fixtureModelArtifact.id,
        }),
      ],
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
});
