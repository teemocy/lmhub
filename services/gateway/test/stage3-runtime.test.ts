import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ProviderSearchService } from "@localhub/engine-llama";
import { resolveAppPaths } from "@localhub/platform";
import { embeddingsResponseSchema } from "@localhub/shared-contracts";
import type {
  ModelProvider,
  ProviderDownloadPlan,
  ProviderDownloadRequest,
  ProviderSearchQuery,
  ProviderSearchResult,
} from "@localhub/shared-contracts/foundation-providers";
import { afterEach, describe, expect, it } from "vitest";

import type { GatewayConfig } from "../src/config.js";
import {
  createRepositoryGatewayRuntime,
  normalizeEmbeddingsResponsePayload,
} from "../src/runtime/repositoryRuntime.js";
import { buildGateway } from "../src/server/app.js";

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

function createSampleGgufBuffer(name: string): Buffer {
  const entries = [
    createMetadataEntry("general.name", TestGgufValueType.String, name),
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

function createSha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

class FakeProvider implements ModelProvider {
  readonly id = "huggingface" as const;
  readonly #plan: ProviderDownloadPlan;

  constructor(plan: ProviderDownloadPlan) {
    this.#plan = plan;
  }

  async search(_query: ProviderSearchQuery): Promise<ProviderSearchResult> {
    return {
      items: [
        {
          provider: "huggingface",
          providerModelId: "acme/stage3-gateway-chat",
          title: "Gateway Stage3 Chat",
          author: "acme",
          repositoryUrl: "https://example.invalid/acme/stage3-gateway-chat",
          tags: ["gguf", "chat"],
          formats: ["gguf"],
          artifacts: [],
        },
      ],
      warnings: [],
    };
  }

  async getModel(_providerModelId: string) {
    return {
      provider: "huggingface" as const,
      providerModelId: "acme/stage3-gateway-chat",
      title: "Gateway Stage3 Chat",
      author: "acme",
      repositoryUrl: "https://example.invalid/acme/stage3-gateway-chat",
      tags: ["gguf", "chat"],
      formats: ["gguf"],
      artifacts: [
        {
          artifactId: this.#plan.artifactId,
          fileName: this.#plan.fileName,
          format: "gguf" as const,
          sizeBytes: this.#plan.estimatedSizeBytes,
          downloadUrl: this.#plan.url,
          checksum: this.#plan.checksum,
        },
      ],
    };
  }

  async resolveDownload(_request: ProviderDownloadRequest): Promise<ProviderDownloadPlan> {
    return this.#plan;
  }
}

interface Fixture {
  cleanup(): Promise<void>;
}

const fixtures: Fixture[] = [];

function createTestConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    defaultModelTtlMs: 1_000,
    maxActiveModelsInMemory: 0,
    publicHost: "127.0.0.1",
    publicPort: 11434,
    controlHost: "127.0.0.1",
    controlPort: 11435,
    localModelsDir: path.join(os.tmpdir(), "localhub-gateway-models"),
    publicBearerToken: "public-secret-stage3",
    controlBearerToken: "control-secret-stage3",
    corsAllowlist: ["localhost", "127.0.0.1"],
    telemetryIntervalMs: 50,
    ...overrides,
  };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const startedAt = Date.now();
  while (!(await predicate())) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition.");
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

afterEach(async () => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop();
    await fixture?.cleanup();
  }
});

describe("gateway stage 3 runtime", () => {
  it("normalizes embeddings usage before validation", () => {
    const normalized = normalizeEmbeddingsResponsePayload({
      object: "list",
      model: "model_qwen3-embedding-4b",
      data: [
        {
          object: "embedding",
          index: 0,
          embedding: [0.1, 0.2, 0.3],
        },
      ],
      usage: {
        prompt_tokens: 12,
        total_tokens: 12,
      },
    });

    const parsed = embeddingsResponseSchema.parse(normalized);
    expect(parsed.usage).toMatchObject({
      prompt_tokens: 12,
      completion_tokens: 0,
      total_tokens: 12,
    });
  });

  it("searches provider catalog and completes a routed download", async () => {
    const supportRoot = await mkdtemp(path.join(os.tmpdir(), "localhub-gateway-stage3-"));
    const payload = createSampleGgufBuffer("Gateway Stage3 Chat");
    const checksumSha256 = createSha256(payload);
    const artifactUrl = "https://example.invalid/artifact.gguf";
    const downloadFetch: typeof fetch = async (_input, init) => {
      const headers = new Headers();
      headers.set("accept-ranges", "bytes");

      if (init?.method === "HEAD") {
        headers.set("content-length", String(payload.length));
        return new Response(null, {
          status: 200,
          headers,
        });
      }

      const rangeHeader =
        init?.headers instanceof Headers
          ? init.headers.get("range")
          : Array.isArray(init?.headers)
            ? (init.headers.find(([key]) => key.toLowerCase() === "range")?.[1] ?? null)
            : init?.headers && "Range" in init.headers
              ? String((init.headers as Record<string, string>).Range)
              : init?.headers && "range" in init.headers
                ? String((init.headers as Record<string, string>).range)
                : null;
      const match = typeof rangeHeader === "string" ? /bytes=(\d+)-(\d+)?/.exec(rangeHeader) : null;
      const start = match ? Number(match[1]) : 0;
      const end = match?.[2] ? Number(match[2]) : payload.length - 1;
      const chunk = payload.subarray(start, end + 1);

      headers.set("content-length", String(chunk.length));
      headers.set("content-range", `bytes ${start}-${end}/${payload.length}`);

      return new Response(chunk, {
        status: match ? 206 : 200,
        headers,
      });
    };
    const runtime = createRepositoryGatewayRuntime({
      cwd: process.cwd(),
      defaultModelTtlMs: 1_000,
      env: {
        ...process.env,
        LOCAL_LLM_HUB_ENV: "test",
      },
      preferFakeWorker: true,
      supportRoot,
      localModelsDir: path.join(supportRoot, "models"),
      telemetryIntervalMs: 50,
      providerSearch: new ProviderSearchService([
        new FakeProvider({
          provider: "huggingface",
          artifactId: "gateway-stage3-chat-q4",
          url: artifactUrl,
          headers: {},
          fileName: "gateway-stage3-chat-q4.gguf",
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
      downloadFetch,
    });
    await runtime.start();
    const gateway = await buildGateway({
      config: createTestConfig(),
      runtime,
    });
    await Promise.all([gateway.publicApp.ready(), gateway.controlApp.ready()]);

    fixtures.push({
      async cleanup() {
        await Promise.allSettled([gateway.publicApp.close(), gateway.controlApp.close()]);
        await runtime.stop();
        await rm(supportRoot, { recursive: true, force: true });
      },
    });

    const searchResponse = await gateway.controlApp.inject({
      method: "GET",
      url: "/control/downloads?q=stage3",
      headers: {
        authorization: "Bearer control-secret-stage3",
      },
    });

    expect(searchResponse.statusCode).toBe(200);
    expect(searchResponse.json()).toMatchObject({
      object: "list",
      data: [
        expect.objectContaining({
          id: "huggingface:acme/stage3-gateway-chat",
          providerModelId: "acme/stage3-gateway-chat",
          title: "Gateway Stage3 Chat",
          repositoryUrl: "https://example.invalid/acme/stage3-gateway-chat",
        }),
      ],
    });

    const detailResponse = await gateway.controlApp.inject({
      method: "GET",
      url: "/control/downloads?provider=huggingface&providerModelId=acme%2Fstage3-gateway-chat",
      headers: {
        authorization: "Bearer control-secret-stage3",
      },
    });

    expect(detailResponse.statusCode).toBe(200);
    expect(detailResponse.json()).toMatchObject({
      object: "model",
      data: expect.objectContaining({
        providerModelId: "acme/stage3-gateway-chat",
        variants: [
          expect.objectContaining({
            primaryArtifactId: "gateway-stage3-chat-q4",
            files: [
              expect.objectContaining({
                artifactId: "gateway-stage3-chat-q4",
                artifactName: "gateway-stage3-chat-q4.gguf",
              }),
            ],
          }),
        ],
      }),
    });

    const createResponse = await gateway.controlApp.inject({
      method: "POST",
      url: "/control/downloads",
      headers: {
        authorization: "Bearer control-secret-stage3",
      },
      payload: {
        provider: "huggingface",
        providerModelId: "acme/stage3-gateway-chat",
        artifactId: "gateway-stage3-chat-q4",
        title: "Gateway Stage3 Chat",
        artifactName: "gateway-stage3-chat-q4.gguf",
        checksumSha256,
        sizeBytes: payload.length,
      },
    });

    expect(createResponse.statusCode).toBe(202);
    const createdTaskId = createResponse.json().task.id as string;

    await waitFor(async () => {
      const downloadsResponse = await gateway.controlApp.inject({
        method: "GET",
        url: "/control/downloads",
        headers: {
          authorization: "Bearer control-secret-stage3",
        },
      });

      const body = downloadsResponse.json() as { data: Array<{ id: string; status: string }> };
      return body.data.some((task) => task.id === createdTaskId && task.status === "completed");
    });

    const finalDownloads = await gateway.controlApp.inject({
      method: "GET",
      url: "/control/downloads",
      headers: {
        authorization: "Bearer control-secret-stage3",
      },
    });

    expect(finalDownloads.json()).toMatchObject({
      object: "list",
      data: [
        expect.objectContaining({
          id: createdTaskId,
          status: "completed",
          progress: 100,
        }),
      ],
    });
  }, 15_000);
});
