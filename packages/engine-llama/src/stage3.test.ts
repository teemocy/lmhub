import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse, createServer } from "node:http";
import os from "node:os";
import path from "node:path";

import {
  DownloadTasksRepository,
  EngineVersionsRepository,
  ModelsRepository,
  createTestDatabase,
} from "@localhub/db";
import type { GatewayEvent } from "@localhub/shared-contracts/foundation-events";
import type {
  ModelProvider,
  ProviderDownloadPlan,
  ProviderDownloadRequest,
  ProviderSearchQuery,
  ProviderSearchResult,
} from "@localhub/shared-contracts/foundation-providers";
import { afterEach, describe, expect, it } from "vitest";

import { LlamaCppDownloadManager } from "./download-manager.js";
import { createLlamaCppAdapter } from "./index.js";
import { LlamaCppModelManager } from "./model-manager.js";
import { HuggingFaceProvider, ModelScopeProvider, ProviderSearchService } from "./providers.js";

const tempDirs: string[] = [];
const cleanups: Array<() => void> = [];

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

function createSampleGgufBuffer(modelName: string): Buffer {
  const entries = [
    createMetadataEntry("general.name", TestGgufValueType.String, modelName),
    createMetadataEntry("general.architecture", TestGgufValueType.String, "llama"),
    createMetadataEntry("general.quantization", TestGgufValueType.String, "Q4_K_M"),
    createMetadataEntry("llama.context_length", TestGgufValueType.Uint32, 8192),
    createMetadataEntry("general.parameter_count", TestGgufValueType.Uint64, 123456789),
    createMetadataEntry("tokenizer.ggml.model", TestGgufValueType.String, "gpt2"),
    createMetadataEntry("tokenizer.chat_template", TestGgufValueType.String, "<s>{{prompt}}</s>"),
  ];

  return Buffer.concat([
    Buffer.from("GGUF", "ascii"),
    uint32Buffer(3),
    uint64Buffer(0),
    uint64Buffer(entries.length),
    ...entries,
  ]);
}

async function createSupportRoot(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "localhub-engine-stage3-"));
  tempDirs.push(directory);
  return directory;
}

function createSha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition.");
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

class FakeProvider implements ModelProvider {
  readonly id = "huggingface" as const;
  readonly #plans: Map<string, ProviderDownloadPlan>;
  readonly #fallbackPlan: ProviderDownloadPlan;

  constructor(plan: ProviderDownloadPlan | ProviderDownloadPlan[]) {
    const plans = Array.isArray(plan) ? plan : [plan];
    this.#plans = new Map(plans.map((entry) => [entry.artifactId, entry]));
    this.#fallbackPlan = plans[0]!;
  }

  async search(_query: ProviderSearchQuery): Promise<ProviderSearchResult> {
    return {
      items: [
        {
          provider: this.id,
          providerModelId: "acme/stage3-tiny-chat",
          title: "Stage3 Tiny Chat",
          repositoryUrl: "https://example.invalid/acme/stage3-tiny-chat",
          tags: ["gguf"],
          formats: ["gguf"],
          artifacts: [],
        },
      ],
      warnings: [],
    };
  }

  async getModel(_providerModelId: string) {
    return {
      provider: this.id,
      providerModelId: "acme/stage3-tiny-chat",
      title: "Stage3 Tiny Chat",
      repositoryUrl: "https://example.invalid/acme/stage3-tiny-chat",
      tags: ["gguf"],
      formats: ["gguf"],
      artifacts: Array.from(this.#plans.values()).map((plan) => ({
        artifactId: plan.artifactId,
        fileName: plan.fileName,
        format: "gguf" as const,
        sizeBytes: plan.estimatedSizeBytes,
        checksum: plan.checksum,
        downloadUrl: plan.url,
      })),
    };
  }

  async resolveDownload(request: ProviderDownloadRequest): Promise<ProviderDownloadPlan> {
    return this.#plans.get(request.artifactId) ?? this.#fallbackPlan;
  }
}

function handleArtifactRequest(
  request: IncomingMessage,
  response: ServerResponse,
  payload: Buffer,
  options: { delayPerChunkMs?: number } = {},
): void {
  if (request.method === "HEAD") {
    response.writeHead(200, {
      "content-length": String(payload.length),
      "accept-ranges": "bytes",
    });
    response.end();
    return;
  }

  const rangeHeader = request.headers.range;
  const match = typeof rangeHeader === "string" ? /bytes=(\d+)-(\d+)?/.exec(rangeHeader) : null;
  const start = match ? Number(match[1]) : 0;
  const end = match?.[2] ? Number(match[2]) : payload.length - 1;
  const chunk = payload.subarray(start, end + 1);
  response.writeHead(match ? 206 : 200, {
    "content-length": String(chunk.length),
    "accept-ranges": "bytes",
    "content-range": `bytes ${start}-${end}/${payload.length}`,
  });

  if (!options.delayPerChunkMs) {
    response.end(chunk);
    return;
  }

  let offset = 0;
  const writeChunk = () => {
    if (offset >= chunk.length) {
      response.end();
      return;
    }

    const next = chunk.subarray(offset, Math.min(offset + 64, chunk.length));
    offset += next.length;
    response.write(next);
    setTimeout(writeChunk, options.delayPerChunkMs);
  };

  writeChunk();
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    cleanup?.();
  }

  while (tempDirs.length > 0) {
    const directory = tempDirs.pop();
    if (directory) {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

describe("llama.cpp stage 3 provider search and downloads", () => {
  it("searches providers by repository first, then loads repo manifests on demand", async () => {
    const observedModelScopeBodies: string[] = [];
    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.startsWith("https://hf.test/api/models")) {
        if (url.includes("?blobs=true")) {
          return new Response(
            JSON.stringify({
              id: "acme/Tiny-Chat-GGUF",
              author: "acme",
              tags: ["gguf", "chat"],
              downloads: 50,
              likes: 7,
              siblings: [
                {
                  rfilename: "tiny-chat-q4.gguf",
                  size: 128,
                  lfs: {
                    sha256: "a".repeat(64),
                    size: 128,
                  },
                },
              ],
            }),
          );
        }

        return new Response(
          JSON.stringify([
            {
              id: "acme/Tiny-Chat-GGUF",
              author: "acme",
              tags: ["gguf", "chat"],
              downloads: 50,
              likes: 7,
              siblings: [{ rfilename: "tiny-chat-q4.gguf" }],
            },
          ]),
        );
      }

      if (url === "https://ms.test/api/v1/models") {
        observedModelScopeBodies.push(String(init?.body ?? ""));
        return new Response(
          JSON.stringify({
            Data: {
              Models: [
                {
                  Path: "ms",
                  Name: "Tiny-Embed-GGUF",
                  Tags: ["gguf", "embeddings"],
                  Downloads: 75,
                  LikeCount: 9,
                  LastUpdatedTime: 1_700_000_000,
                },
              ],
            },
          }),
        );
      }

      if (url === "https://ms.test/api/v1/models/ms/Tiny-Embed-GGUF/repo/files?Recursive=True") {
        return new Response(
          JSON.stringify({
            Data: {
              Files: [
                {
                  Path: "tiny-embed-q8.gguf",
                  Size: 256,
                  Revision: "main",
                  Sha256: "b".repeat(64),
                },
              ],
            },
          }),
        );
      }

      return new Response(null, { status: 404 });
    };

    const service = new ProviderSearchService([
      new HuggingFaceProvider({
        fetch: mockFetch,
        huggingFaceBaseUrl: "https://hf.test",
      }),
      new ModelScopeProvider({
        fetch: mockFetch,
        modelScopeBaseUrl: "https://ms.test",
      }),
    ]);

    const result = await service.search({
      text: "tiny",
      formats: ["gguf"],
      limit: 10,
    });

    expect(result.items).toHaveLength(2);
    expect(result.items.map((item) => item.provider)).toEqual(["modelscope", "huggingface"]);
    expect(result.items.every((item) => item.artifacts.length === 0)).toBe(true);
    expect(result.items[0]?.formats).toEqual(["gguf"]);
    expect(result.items[1]?.formats).toEqual(["gguf"]);
    expect(observedModelScopeBodies).toEqual([
      JSON.stringify({
        PageSize: 30,
        PageNumber: 1,
        Target: "tiny",
        Sort: {
          SortBy: "Default",
        },
        Criterion: [],
      }),
    ]);

    const modelscopeDetail = await service.getModel("modelscope", "ms/Tiny-Embed-GGUF");
    const huggingFaceDetail = await service.getModel("huggingface", "acme/Tiny-Chat-GGUF");

    expect(modelscopeDetail.artifacts[0]?.fileName).toBe("tiny-embed-q8.gguf");
    expect(modelscopeDetail.artifacts[0]?.sizeBytes).toBe(256);
    expect(huggingFaceDetail.artifacts[0]?.downloadUrl).toContain("tiny-chat-q4.gguf");
    expect(huggingFaceDetail.artifacts[0]?.sizeBytes).toBe(128);
    expect(observedModelScopeBodies).toEqual([
      JSON.stringify({
        PageSize: 30,
        PageNumber: 1,
        Target: "tiny",
        Sort: {
          SortBy: "Default",
        },
        Criterion: [],
      }),
      JSON.stringify({
        PageSize: 10,
        PageNumber: 1,
        Target: "ms/Tiny-Embed-GGUF",
        Sort: {
          SortBy: "Default",
        },
        Criterion: [],
      }),
    ]);
  });

  it("pauses and resumes a ranged download, then auto-registers the artifact", async () => {
    const supportRoot = await createSupportRoot();
    const payload = createSampleGgufBuffer("Stage3 Tiny Chat");
    const checksumSha256 = createSha256(payload);
    const observedAuthHeaders: string[] = [];
    const server = createServer((request, response) => {
      if (request.url === "/artifact.gguf") {
        observedAuthHeaders.push(String(request.headers.authorization ?? ""));
        handleArtifactRequest(request, response, payload, { delayPerChunkMs: 10 });
        return;
      }

      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    cleanups.push(() => server.close());
    const port = (server.address() as { port: number }).port;

    const database = createTestDatabase();
    cleanups.push(database.cleanup);

    const modelsRepository = new ModelsRepository(database.database);
    const manager = new LlamaCppModelManager({
      supportRoot,
      localModelsDir: path.join(supportRoot, "models"),
      adapter: createLlamaCppAdapter({
        supportRoot,
        preferFakeWorker: true,
      }),
      modelsRepository,
      engineVersionsRepository: new EngineVersionsRepository(database.database),
    });
    const events: GatewayEvent[] = [];
    const downloads = new LlamaCppDownloadManager({
      supportRoot,
      downloadsRepository: new DownloadTasksRepository(database.database),
      modelManager: manager,
      providerSearch: new ProviderSearchService([
        new FakeProvider({
          provider: "huggingface",
          artifactId: "stage3-tiny-chat-q4",
          url: `http://127.0.0.1:${port}/artifact.gguf`,
          headers: {
            Authorization: "Bearer stage3-token",
          },
          fileName: "stage3-tiny-chat-q4.gguf",
          checksum: {
            algorithm: "sha256",
            value: checksumSha256,
            source: "provider",
            status: "verified",
          },
          supportsRange: true,
          estimatedSizeBytes: payload.length,
        }),
      ]),
      emitEvent: (event) => {
        events.push(event);
      },
      chunkBytes: 96,
    });

    const started = await downloads.startDownload({
      provider: "huggingface",
      providerModelId: "acme/stage3-tiny-chat",
      artifactId: "stage3-tiny-chat-q4",
      displayName: "Stage3 Tiny Chat",
    });

    await waitFor(() =>
      events.some(
        (event) =>
          event.type === "DOWNLOAD_PROGRESS" &&
          event.payload.taskId === started.id &&
          event.payload.downloadedBytes > 0,
      ),
    );
    await downloads.pauseDownload(started.id);
    await waitFor(
      () => downloads.listDownloads().find((task) => task.id === started.id)?.status === "paused",
    );

    const resumed = await downloads.resumeDownload(started.id);

    expect(resumed.status).toBe("completed");
    expect(modelsRepository.list()).toHaveLength(1);
    expect(modelsRepository.list()[0]?.artifact.source.kind).toBe("huggingface");
    expect(observedAuthHeaders).toContain("Bearer stage3-token");
    expect(
      events.some(
        (event) => event.type === "DOWNLOAD_PROGRESS" && event.payload.status === "completed",
      ),
    ).toBe(true);
  }, 15_000);

  it("marks a download as failed when the checksum does not match", async () => {
    const supportRoot = await createSupportRoot();
    const payload = createSampleGgufBuffer("Broken Tiny Chat");
    const server = createServer((request, response) => {
      if (request.url === "/broken.gguf") {
        handleArtifactRequest(request, response, payload);
        return;
      }

      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    cleanups.push(() => server.close());
    const port = (server.address() as { port: number }).port;

    const database = createTestDatabase();
    cleanups.push(database.cleanup);

    const modelsRepository = new ModelsRepository(database.database);
    const manager = new LlamaCppModelManager({
      supportRoot,
      localModelsDir: path.join(supportRoot, "models"),
      adapter: createLlamaCppAdapter({
        supportRoot,
        preferFakeWorker: true,
      }),
      modelsRepository,
      engineVersionsRepository: new EngineVersionsRepository(database.database),
    });
    const downloads = new LlamaCppDownloadManager({
      supportRoot,
      downloadsRepository: new DownloadTasksRepository(database.database),
      modelManager: manager,
      providerSearch: new ProviderSearchService([
        new FakeProvider({
          provider: "huggingface",
          artifactId: "broken-stage3-tiny-chat-q4",
          url: `http://127.0.0.1:${port}/broken.gguf`,
          headers: {},
          fileName: "broken-stage3-tiny-chat-q4.gguf",
          checksum: {
            algorithm: "sha256",
            value: "0".repeat(64),
            source: "provider",
            status: "verified",
          },
          supportsRange: true,
          estimatedSizeBytes: payload.length,
        }),
      ]),
      chunkBytes: 128,
    });

    const started = await downloads.startDownload({
      provider: "huggingface",
      providerModelId: "acme/broken-stage3-tiny-chat",
      artifactId: "broken-stage3-tiny-chat-q4",
    });
    const completed = await downloads.resumeDownload(started.id);

    expect(completed.status).toBe("error");
    expect(completed.errorMessage).toContain("checksum");
    expect(modelsRepository.list()).toHaveLength(0);
  }, 15_000);

  it("downloads every shard in a bundle and registers only the primary shard once complete", async () => {
    const supportRoot = await createSupportRoot();
    const primaryPayload = createSampleGgufBuffer("Bundle Tiny Chat");
    const secondaryPayload = Buffer.from("secondary shard payload", "utf8");
    const primaryChecksumSha256 = createSha256(primaryPayload);
    const secondaryChecksumSha256 = createSha256(secondaryPayload);
    const server = createServer((request, response) => {
      if (request.url === "/bundle-00001.gguf") {
        handleArtifactRequest(request, response, primaryPayload);
        return;
      }

      if (request.url === "/bundle-00002.gguf") {
        handleArtifactRequest(request, response, secondaryPayload);
        return;
      }

      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    cleanups.push(() => server.close());
    const port = (server.address() as { port: number }).port;

    const database = createTestDatabase();
    cleanups.push(database.cleanup);

    const modelsRepository = new ModelsRepository(database.database);
    const manager = new LlamaCppModelManager({
      supportRoot,
      localModelsDir: path.join(supportRoot, "models"),
      adapter: createLlamaCppAdapter({
        supportRoot,
        preferFakeWorker: true,
      }),
      modelsRepository,
      engineVersionsRepository: new EngineVersionsRepository(database.database),
    });
    const downloads = new LlamaCppDownloadManager({
      supportRoot,
      downloadsRepository: new DownloadTasksRepository(database.database),
      modelManager: manager,
      providerSearch: new ProviderSearchService([
        new FakeProvider([
          {
            provider: "huggingface",
            artifactId: "bundle-chat-bf16-00001",
            url: `http://127.0.0.1:${port}/bundle-00001.gguf`,
            headers: {},
            fileName: "BF16/bundle-chat-BF16-00001-of-00002.gguf",
            checksum: {
              algorithm: "sha256",
              value: primaryChecksumSha256,
              source: "provider",
              status: "verified",
            },
            supportsRange: true,
            estimatedSizeBytes: primaryPayload.length,
          },
          {
            provider: "huggingface",
            artifactId: "bundle-chat-bf16-00002",
            url: `http://127.0.0.1:${port}/bundle-00002.gguf`,
            headers: {},
            fileName: "BF16/bundle-chat-BF16-00002-of-00002.gguf",
            checksum: {
              algorithm: "sha256",
              value: secondaryChecksumSha256,
              source: "provider",
              status: "verified",
            },
            supportsRange: true,
            estimatedSizeBytes: secondaryPayload.length,
          },
        ]),
      ]),
      chunkBytes: 128,
    });

    const bundleId = "stage3-bundle-chat-bf16";
    await downloads.startDownload({
      provider: "huggingface",
      providerModelId: "acme/stage3-bundle-chat",
      artifactId: "bundle-chat-bf16-00001",
      displayName: "Bundle Tiny Chat",
      autoRegister: true,
      bundleId,
      bundlePrimaryArtifactId: "bundle-chat-bf16-00001",
    });
    await downloads.startDownload({
      provider: "huggingface",
      providerModelId: "acme/stage3-bundle-chat",
      artifactId: "bundle-chat-bf16-00002",
      displayName: "Bundle Tiny Chat",
      autoRegister: false,
      bundleId,
      bundlePrimaryArtifactId: "bundle-chat-bf16-00001",
    });

    await waitFor(() => downloads.listDownloads().every((task) => task.status === "completed"));
    await waitFor(() => modelsRepository.list().length === 1);

    const storedModel = modelsRepository.list();
    expect(storedModel).toHaveLength(1);
    expect(storedModel[0]?.artifact.localPath).toBe(
      path.join(
        supportRoot,
        "models",
        "acme-stage3-bundle-chat",
        "BF16",
        "bundle-chat-BF16-00001-of-00002.gguf",
      ),
    );

    const completedTasks = downloads.listDownloads();
    expect(completedTasks.filter((task) => task.modelId)).toHaveLength(1);
    expect(completedTasks.some((task) => task.fileName.endsWith("00002-of-00002.gguf"))).toBe(true);
  }, 15_000);

  it("stores downloads under the configured local models directory", async () => {
    const supportRoot = await createSupportRoot();
    const localModelsDir = path.join(supportRoot, "custom-models");
    const payload = createSampleGgufBuffer("Configured Models Dir");
    const checksumSha256 = createSha256(payload);
    const server = createServer((request, response) => {
      if (request.url === "/configured.gguf") {
        handleArtifactRequest(request, response, payload);
        return;
      }

      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    cleanups.push(() => server.close());
    const port = (server.address() as { port: number }).port;

    const database = createTestDatabase();
    cleanups.push(database.cleanup);

    const modelsRepository = new ModelsRepository(database.database);
    const manager = new LlamaCppModelManager({
      supportRoot,
      localModelsDir,
      adapter: createLlamaCppAdapter({
        supportRoot,
        preferFakeWorker: true,
      }),
      modelsRepository,
      engineVersionsRepository: new EngineVersionsRepository(database.database),
    });
    const downloads = new LlamaCppDownloadManager({
      supportRoot,
      localModelsDir,
      downloadsRepository: new DownloadTasksRepository(database.database),
      modelManager: manager,
      providerSearch: new ProviderSearchService([
        new FakeProvider({
          provider: "huggingface",
          artifactId: "configured-dir-chat-q4",
          url: `http://127.0.0.1:${port}/configured.gguf`,
          headers: {},
          fileName: "configured-dir-chat-q4.gguf",
          checksum: {
            algorithm: "sha256",
            value: checksumSha256,
            source: "provider",
            status: "verified",
          },
          supportsRange: true,
          estimatedSizeBytes: payload.length,
        }),
      ]),
    });

    const started = await downloads.startDownload({
      provider: "huggingface",
      providerModelId: "acme/configured-dir-chat",
      artifactId: "configured-dir-chat-q4",
      displayName: "Configured Models Dir",
    });
    const completed = await downloads.resumeDownload(started.id);

    expect(completed.status).toBe("completed");
    expect(modelsRepository.list()).toHaveLength(1);
    expect(modelsRepository.list()[0]?.artifact.localPath).toBe(
      path.join(localModelsDir, "acme-configured-dir-chat", "configured-dir-chat-q4.gguf"),
    );
  }, 15_000);

  it("registers an MLX bundle once core files complete even if config.json fails", async () => {
    const supportRoot = await createSupportRoot();
    const database = createTestDatabase();
    cleanups.push(database.cleanup);

    const tokenizerPayload = Buffer.from("{\"model\":\"bpe\"}\n", "utf8");
    const shardPayload = Buffer.from("mlx shard payload", "utf8");
    const registrarCalls: string[] = [];
    const downloads = new LlamaCppDownloadManager({
      supportRoot,
      downloadsRepository: new DownloadTasksRepository(database.database),
      modelRegistrars: {
        mlx: {
          async registerLocalModel(options) {
            registrarCalls.push(options.filePath);
            return {
              artifact: {
                id: "model_stage3_mlx",
                sizeBytes: tokenizerPayload.length + shardPayload.length,
              },
              profile: {
                displayName: "Stage3 MLX",
              },
            };
          },
        },
      },
      providerSearch: new ProviderSearchService([
        new FakeProvider([
          {
            provider: "huggingface",
            artifactId: "mlx-config",
            url: "https://example.invalid/mlx/config.json",
            headers: {},
            fileName: "4bit/config.json",
            supportsRange: false,
            estimatedSizeBytes: 32,
          },
          {
            provider: "huggingface",
            artifactId: "mlx-tokenizer",
            url: "https://example.invalid/mlx/tokenizer.json",
            headers: {},
            fileName: "4bit/tokenizer.json",
            supportsRange: false,
            estimatedSizeBytes: tokenizerPayload.length,
          },
          {
            provider: "huggingface",
            artifactId: "mlx-shard",
            url: "https://example.invalid/mlx/model.safetensors",
            headers: {},
            fileName: "4bit/model.safetensors",
            supportsRange: false,
            estimatedSizeBytes: shardPayload.length,
          },
        ]),
      ]),
      fetch: async (input) => {
        const url = String(input);
        if (url.endsWith("/config.json")) {
          return new Response(null, { status: 500 });
        }
        if (url.endsWith("/tokenizer.json")) {
          return new Response(tokenizerPayload, {
            status: 200,
            headers: {
              "content-length": String(tokenizerPayload.length),
            },
          });
        }
        if (url.endsWith("/model.safetensors")) {
          return new Response(shardPayload, {
            status: 200,
            headers: {
              "content-length": String(shardPayload.length),
            },
          });
        }

        return new Response(null, { status: 404 });
      },
    });

    const bundleId = "stage3-mlx-bundle";
    await downloads.startDownload({
      provider: "huggingface",
      providerModelId: "acme/stage3-mlx",
      artifactId: "mlx-config",
      displayName: "Stage3 MLX",
      bundleId,
      bundlePrimaryArtifactId: "mlx-config",
      engineType: "mlx",
      registrationPath: "4bit",
    });
    await downloads.startDownload({
      provider: "huggingface",
      providerModelId: "acme/stage3-mlx",
      artifactId: "mlx-tokenizer",
      displayName: "Stage3 MLX",
      bundleId,
      bundlePrimaryArtifactId: "mlx-config",
      engineType: "mlx",
      registrationPath: "4bit",
    });
    await downloads.startDownload({
      provider: "huggingface",
      providerModelId: "acme/stage3-mlx",
      artifactId: "mlx-shard",
      displayName: "Stage3 MLX",
      bundleId,
      bundlePrimaryArtifactId: "mlx-config",
      engineType: "mlx",
      registrationPath: "4bit",
    });

    await waitFor(() => registrarCalls.length === 1);

    const tasks = downloads.listDownloads();
    expect(registrarCalls).toEqual([
      path.join(supportRoot, "models", "acme-stage3-mlx", "4bit"),
    ]);
    expect(tasks.find((task) => task.artifactId === "mlx-config")?.status).toBe("error");
  }, 15_000);

  it("repairs stale MLX bundle errors once the bundle exists on disk", async () => {
    const supportRoot = await createSupportRoot();
    const database = createTestDatabase();
    cleanups.push(database.cleanup);

    const downloadsRepository = new DownloadTasksRepository(database.database);
    const downloads = new LlamaCppDownloadManager({
      supportRoot,
      downloadsRepository,
      modelRegistrars: {
        mlx: {
          async registerLocalModel() {
            return {
              artifact: {
                id: "model_stage3_mlx_ready",
                sizeBytes: 0,
              },
              profile: {
                displayName: "Stage3 MLX Ready",
              },
            };
          },
        },
      },
      providerSearch: new ProviderSearchService([
        new FakeProvider({
          provider: "huggingface",
          artifactId: "unused",
          url: "https://example.invalid/unused",
          headers: {},
          fileName: "unused.bin",
          supportsRange: false,
          estimatedSizeBytes: 0,
        }),
      ]),
    });

    const modelDir = path.join(supportRoot, "models", "acme-stage3-mlx", "4bit");
    await mkdir(modelDir, { recursive: true });
    await writeFile(path.join(modelDir, "config.json"), "{}\n");
    await writeFile(path.join(modelDir, "tokenizer.json"), "{}\n");
    await writeFile(path.join(modelDir, "model.safetensors"), "weights\n");

    const now = new Date().toISOString();
    const bundleId = "stage3-mlx-ready";
    downloadsRepository.upsert({
      id: "mlx-config-task",
      provider: "huggingface",
      url: "https://example.invalid/mlx/config.json",
      totalBytes: 3,
      downloadedBytes: 3,
      status: "error",
      errorMessage: `Expected an MLX model directory, received ${modelDir}.`,
      metadata: {
        providerModelId: "acme/stage3-mlx",
        artifactId: "mlx-config",
        fileName: "config.json",
        destinationPath: path.join(modelDir, "config.json"),
        partialPath: path.join(supportRoot, "downloads", "partials", "mlx-config-task.part"),
        bundleId,
        bundlePrimaryArtifactId: "mlx-config",
        engineType: "mlx",
        registrationPath: "4bit",
      },
      createdAt: now,
      updatedAt: now,
    });
    downloadsRepository.upsert({
      id: "mlx-tokenizer-task",
      provider: "huggingface",
      url: "https://example.invalid/mlx/tokenizer.json",
      totalBytes: 3,
      downloadedBytes: 3,
      status: "completed",
      metadata: {
        providerModelId: "acme/stage3-mlx",
        artifactId: "mlx-tokenizer",
        fileName: "tokenizer.json",
        destinationPath: path.join(modelDir, "tokenizer.json"),
        partialPath: path.join(supportRoot, "downloads", "partials", "mlx-tokenizer-task.part"),
        bundleId,
        bundlePrimaryArtifactId: "mlx-config",
        engineType: "mlx",
        registrationPath: "4bit",
      },
      createdAt: now,
      updatedAt: now,
    });
    downloadsRepository.upsert({
      id: "mlx-shard-task",
      provider: "huggingface",
      url: "https://example.invalid/mlx/model.safetensors",
      totalBytes: 8,
      downloadedBytes: 8,
      status: "completed",
      metadata: {
        providerModelId: "acme/stage3-mlx",
        artifactId: "mlx-shard",
        fileName: "model.safetensors",
        destinationPath: path.join(modelDir, "model.safetensors"),
        partialPath: path.join(supportRoot, "downloads", "partials", "mlx-shard-task.part"),
        bundleId,
        bundlePrimaryArtifactId: "mlx-config",
        engineType: "mlx",
        registrationPath: "4bit",
      },
      createdAt: now,
      updatedAt: now,
    });

    const tasks = downloads.listDownloads();
    expect(tasks.find((task) => task.artifactId === "mlx-config")).toMatchObject({
      status: "completed",
      downloadedBytes: 3,
      totalBytes: 3,
    });
    expect(tasks.find((task) => task.artifactId === "mlx-config")?.errorMessage).toBeUndefined();
  });
});
