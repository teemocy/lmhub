import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { AddressInfo } from "node:net";

import { type GatewayEvent, gatewayEventSchema } from "@localhub/shared-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { GatewayConfig } from "../src/config.js";
import { MockGatewayRuntime } from "../src/runtime/mockRuntime.js";
import { buildGateway, pipeStreamingResponse, stopGatewayServices } from "../src/server/app.js";
import { GatewayRequestError, type GatewayRuntime } from "../src/types.js";

interface TestGateway {
  runtime: GatewayRuntime;
  publicApp: Awaited<ReturnType<typeof buildGateway>>["publicApp"];
  controlApp: Awaited<ReturnType<typeof buildGateway>>["controlApp"];
}

const activeGateways: TestGateway[] = [];

function createTestConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    defaultModelTtlMs: 1_000,
    publicHost: "127.0.0.1",
    publicPort: 11434,
    controlHost: "127.0.0.1",
    controlPort: 11435,
    localModelsDir: path.join(os.tmpdir(), "localhub-gateway-models"),
    publicBearerToken: "public-secret",
    controlBearerToken: "control-secret",
    corsAllowlist: ["localhost", "127.0.0.1"],
    telemetryIntervalMs: 50,
    ...overrides,
  };
}

async function createTestGateway(overrides: Partial<GatewayConfig> = {}): Promise<TestGateway> {
  const runtime = new MockGatewayRuntime({
    telemetryIntervalMs: overrides.telemetryIntervalMs ?? 50,
  });
  runtime.start();

  const gateway = await buildGateway({
    config: createTestConfig(overrides),
    runtime,
  });

  await Promise.all([gateway.publicApp.ready(), gateway.controlApp.ready()]);

  const testGateway = {
    runtime,
    publicApp: gateway.publicApp,
    controlApp: gateway.controlApp,
  };

  activeGateways.push(testGateway);
  return testGateway;
}

function toBaseUrl(address: string | AddressInfo | null): string {
  if (typeof address === "string") {
    return address;
  }

  if (!address) {
    throw new Error("Listening address is unavailable.");
  }

  return `http://${address.address}:${address.port}`;
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 5_000,
  intervalMs = 25,
): Promise<void> {
  const startedAt = Date.now();

  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error("Timed out waiting for the expected condition.");
    }

    await new Promise((resolve) => {
      setTimeout(resolve, intervalMs);
    });
  }
}

afterEach(async () => {
  while (activeGateways.length > 0) {
    const gateway = activeGateways.pop();
    if (!gateway) {
      continue;
    }

    gateway.runtime.stop();
    await Promise.allSettled([gateway.publicApp.close(), gateway.controlApp.close()]);
  }
});

describe("gateway skeleton", () => {
  it("lists mocked models and preserves request ids", async () => {
    const gateway = await createTestGateway();

    const response = await gateway.publicApp.inject({
      method: "GET",
      url: "/v1/models",
      headers: {
        authorization: "Bearer public-secret",
        "x-request-id": "req-stage1",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-request-id"]).toBe("req-stage1");
    expect(response.json()).toMatchObject({
      object: "list",
      data: expect.arrayContaining([
        expect.objectContaining({
          id: "Tinyllama 1.1b Chat Q4",
          model_id: "localhub/tinyllama-1.1b-chat-q4",
        }),
      ]),
    });
  });

  it("accepts API key headers on public and control routes", async () => {
    const gateway = await createTestGateway();

    const publicResponse = await gateway.publicApp.inject({
      method: "GET",
      url: "/v1/models",
      headers: {
        "x-api-key": "public-secret",
      },
    });

    expect(publicResponse.statusCode).toBe(200);

    const controlResponse = await gateway.controlApp.inject({
      method: "GET",
      url: "/control/models",
      headers: {
        "api-key": "control-secret",
      },
    });

    expect(controlResponse.statusCode).toBe(200);
  });

  it("rejects unauthorized public API requests when a bearer token is configured", async () => {
    const gateway = await createTestGateway();

    const response = await gateway.publicApp.inject({
      method: "GET",
      url: "/v1/models",
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: "unauthorized",
    });
  });

  it("serves CORS preflight requests for local renderer origins", async () => {
    const gateway = await createTestGateway();

    const response = await gateway.publicApp.inject({
      method: "OPTIONS",
      url: "/v1/models",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "GET",
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
  });

  it("limits control routes to loopback clients and supports model preload", async () => {
    const gateway = await createTestGateway();

    const forbiddenResponse = await gateway.controlApp.inject({
      method: "POST",
      url: "/control/models/preload",
      remoteAddress: "192.168.1.77",
      headers: {
        authorization: "Bearer control-secret",
      },
      payload: {
        modelId: "localhub/tinyllama-1.1b-chat-q4",
      },
    });

    expect(forbiddenResponse.statusCode).toBe(403);

    const acceptedResponse = await gateway.controlApp.inject({
      method: "POST",
      url: "/control/models/preload",
      headers: {
        authorization: "Bearer control-secret",
      },
      payload: {
        modelId: "localhub/tinyllama-1.1b-chat-q4",
      },
    });

    expect(acceptedResponse.statusCode).toBe(202);
    expect(acceptedResponse.json()).toMatchObject({
      accepted: true,
      model: expect.objectContaining({
        id: "localhub/tinyllama-1.1b-chat-q4",
        state: "Ready",
        loaded: true,
      }),
    });
  });

  it("lets a loaded model keep a custom alias without eviction", async () => {
    const gateway = await createTestGateway();

    const preloadResponse = await gateway.controlApp.inject({
      method: "POST",
      url: "/control/models/preload",
      headers: {
        authorization: "Bearer control-secret",
      },
      payload: {
        modelId: "localhub/tinyllama-1.1b-chat-q4",
      },
    });

    expect(preloadResponse.statusCode).toBe(202);

    const renameResponse = await gateway.controlApp.inject({
      method: "PUT",
      url: "/config/models/localhub/tinyllama-1.1b-chat-q4",
      headers: {
        authorization: "Bearer control-secret",
      },
      payload: {
        displayName: "Tiny Llama Alias",
      },
    });

    expect(renameResponse.statusCode).toBe(200);
    expect(renameResponse.json()).toMatchObject({
      model: expect.objectContaining({
        displayName: "Tiny Llama Alias",
        loaded: true,
        state: "ready",
      }),
    });

    const listResponse = await gateway.publicApp.inject({
      method: "GET",
      url: "/v1/models",
      headers: {
        authorization: "Bearer public-secret",
      },
    });

    expect(listResponse.statusCode).toBe(200);
    expect(listResponse.json()).toMatchObject({
      object: "list",
      data: expect.arrayContaining([
        expect.objectContaining({
          id: "Tiny Llama Alias",
          model_id: "localhub/tinyllama-1.1b-chat-q4",
        }),
      ]),
    });

    const chatResponse = await gateway.publicApp.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: {
        authorization: "Bearer public-secret",
      },
      payload: {
        model: "Tiny Llama Alias",
        messages: [
          {
            role: "user",
            content: "Hello from the alias.",
          },
        ],
      },
    });

    expect(chatResponse.statusCode).toBe(200);
    expect(chatResponse.json()).toMatchObject({
      model: "Tiny Llama Alias",
    });

    const blockedResponse = await gateway.controlApp.inject({
      method: "PUT",
      url: "/config/models/localhub/tinyllama-1.1b-chat-q4",
      headers: {
        authorization: "Bearer control-secret",
      },
      payload: {
        contextLength: 4096,
      },
    });

    expect(blockedResponse.statusCode).toBe(409);
    expect(blockedResponse.json()).toMatchObject({
      error: "model_config_requires_cold_state",
    });
  });

  it("streams telemetry over the control websocket", async () => {
    const gateway = await createTestGateway();
    const ws = await gateway.controlApp.injectWS("/control/events", {
      headers: {
        authorization: "Bearer control-secret",
      },
    });

    const messages: GatewayEvent[] = [];

    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Timed out waiting for telemetry events."));
      }, 5_000);

      ws.on("message", (rawData) => {
        messages.push(gatewayEventSchema.parse(JSON.parse(rawData.toString())));
        const hasModelState = messages.some((event) => event.type === "MODEL_STATE_CHANGED");
        const hasTrace = messages.some((event) => event.type === "REQUEST_TRACE");

        if (hasModelState && hasTrace) {
          clearTimeout(timer);
          resolve();
        }
      });

      ws.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    await gateway.controlApp.inject({
      method: "POST",
      url: "/control/models/preload",
      headers: {
        authorization: "Bearer control-secret",
      },
      payload: {
        modelId: "localhub/tinyllama-1.1b-chat-q4",
      },
    });

    await gateway.controlApp.inject({
      method: "GET",
      url: "/control/health",
      headers: {
        authorization: "Bearer control-secret",
      },
    });

    await done;
    ws.terminate();

    expect(messages.some((event) => event.type === "MODEL_STATE_CHANGED")).toBe(true);
    expect(messages.some((event) => event.type === "REQUEST_TRACE")).toBe(true);
  });

  it("cancels an in-flight streamed chat response when the client closes the socket", async () => {
    const requestRaw = new EventEmitter();
    const replyRaw = new PassThrough();
    const request = { raw: requestRaw } as unknown as Parameters<typeof pipeStreamingResponse>[0];
    const reply = { raw: replyRaw } as unknown as Parameters<typeof pipeStreamingResponse>[1];
    let streamCancelled = false;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              id: "chatcmpl-cancel-test",
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: "localhub/tinyllama-1.1b-chat-q4",
              choices: [
                {
                  index: 0,
                  delta: { content: "hello" },
                  finish_reason: null,
                },
              ],
            })}\n\n`,
          ),
        );
      },
      cancel() {
        streamCancelled = true;
      },
    });

    const pipePromise = pipeStreamingResponse(request, reply, stream);
    requestRaw.emit("close");
    await waitForCondition(() => streamCancelled);
    await pipePromise;

    expect(streamCancelled).toBe(true);
  });

  it("updates cold model configuration through the control plane", async () => {
    const gateway = await createTestGateway();

    const response = await gateway.controlApp.inject({
      method: "PUT",
      url: "/config/models/localhub/tinyllama-1.1b-chat-q4",
      headers: {
        authorization: "Bearer control-secret",
      },
      payload: {
        defaultTtlMs: 1_800_000,
        contextLength: 4096,
        batchSize: 3072,
        gpuLayers: 16,
        flashAttentionType: "enabled",
        parallelSlots: 6,
        pinned: true,
        capabilityOverrides: {
          chat: false,
          embeddings: true,
          tools: false,
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      model: expect.objectContaining({
        id: "localhub/tinyllama-1.1b-chat-q4",
        defaultTtlMs: 1_800_000,
        contextLength: 4096,
        batchSize: 3072,
        gpuLayers: 16,
        flashAttentionType: "enabled",
        parallelSlots: 6,
        pinned: true,
        capabilityOverrides: {
          chat: false,
          embeddings: true,
          tools: false,
        },
        role: "embeddings",
        capabilities: expect.arrayContaining(["embeddings"]),
      }),
    });
  });

  it("waits for runtime shutdown before removing discovery state", async () => {
    const supportRoot = await mkdtemp(path.join(os.tmpdir(), "localhub-gateway-stop-"));
    const discoveryFile = path.join(supportRoot, "gateway-discovery.json");
    const stopDelayMs = 100;
    let closedApps = 0;
    const runtime: GatewayRuntime = {
      start() {},
      async stop() {
        await new Promise((resolve) => {
          setTimeout(resolve, stopDelayMs);
        });
      },
      subscribe() {
        return () => {};
      },
      listModels() {
        return [];
      },
      listRuntimeModels() {
        return [];
      },
      async listDesktopModels() {
        return [];
      },
      listDownloads() {
        return [];
      },
      listEngines() {
        return [];
      },
      getHealthSnapshot(plane) {
        return {
          status: "ok",
          plane,
          uptimeMs: 0,
          loadedModelCount: 0,
          activeWebSocketClients: 0,
        };
      },
      async registerLocalModel() {
        throw new Error("not implemented");
      },
      deleteChatSession() {
        return false;
      },
      async preloadModel() {
        throw new Error("not implemented");
      },
      async evictModel() {
        throw new Error("not implemented");
      },
      recordRequestTrace() {},
    };
    const gateway = {
      runtime,
      publicApp: {
        async close() {
          closedApps += 1;
        },
      },
      controlApp: {
        async close() {
          closedApps += 1;
        },
      },
    };

    try {
      await writeFile(discoveryFile, JSON.stringify({ pid: process.pid }), "utf8");

      await expect(access(discoveryFile)).resolves.toBeUndefined();

      let stopResolved = false;
      const startedAt = Date.now();
      const stopPromise = stopGatewayServices(gateway, discoveryFile).then(() => {
        stopResolved = true;
      });

      await new Promise((resolve) => {
        setTimeout(resolve, 25);
      });

      expect(stopResolved).toBe(false);
      await expect(access(discoveryFile)).resolves.toBeUndefined();

      await stopPromise;
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(stopDelayMs - 20);
      expect(closedApps).toBe(2);

      await expect(access(discoveryFile)).rejects.toThrow();
    } finally {
      await rm(supportRoot, { recursive: true, force: true });
    }
  });

  it("returns 400 validation_error for malformed stage 3 control payloads", async () => {
    const gateway = await createTestGateway();

    const chatSessionResponse = await gateway.controlApp.inject({
      method: "POST",
      url: "/control/chat/sessions",
      headers: {
        authorization: "Bearer control-secret",
      },
      payload: {
        id: 123,
      },
    });

    const chatRunResponse = await gateway.controlApp.inject({
      method: "POST",
      url: "/control/chat/run",
      headers: {
        authorization: "Bearer control-secret",
      },
      payload: {
        model: "",
        message: "",
      },
    });

    const downloadCreateResponse = await gateway.controlApp.inject({
      method: "POST",
      url: "/control/downloads",
      headers: {
        authorization: "Bearer control-secret",
      },
      payload: {
        provider: "huggingface",
        providerModelId: "",
      },
    });

    expect(chatSessionResponse.statusCode).toBe(400);
    expect(chatSessionResponse.json()).toMatchObject({
      error: "validation_error",
    });
    expect(chatRunResponse.statusCode).toBe(400);
    expect(chatRunResponse.json()).toMatchObject({
      error: "validation_error",
    });
    expect(downloadCreateResponse.statusCode).toBe(400);
    expect(downloadCreateResponse.json()).toMatchObject({
      error: "validation_error",
    });
  });

  it("deletes chat sessions through the control plane", async () => {
    const gateway = await createTestGateway();

    const createResponse = await gateway.controlApp.inject({
      method: "POST",
      url: "/control/chat/sessions",
      headers: {
        authorization: "Bearer control-secret",
      },
      payload: {
        title: "Session to delete",
        modelId: "localhub/tinyllama-1.1b-chat-q4",
        systemPrompt: "Be concise.",
      },
    });

    expect(createResponse.statusCode).toBe(200);

    const createdSession = createResponse.json() as { id: string };
    const deleteResponse = await gateway.controlApp.inject({
      method: "DELETE",
      url: `/control/chat/sessions/${createdSession.id}`,
      headers: {
        authorization: "Bearer control-secret",
      },
    });
    const sessionsResponse = await gateway.controlApp.inject({
      method: "GET",
      url: "/control/chat/sessions",
      headers: {
        authorization: "Bearer control-secret",
      },
    });

    expect(deleteResponse.statusCode).toBe(204);
    expect(sessionsResponse.statusCode).toBe(200);
    expect(sessionsResponse.json()).toMatchObject({
      object: "list",
      data: [],
    });
  });

  it("maps stage 4 runtime hardening errors on control routes", async () => {
    const runtime: GatewayRuntime = {
      start() {},
      async stop() {},
      subscribe() {
        return () => {};
      },
      listModels() {
        return [];
      },
      listRuntimeModels() {
        return [];
      },
      async listDesktopModels() {
        return [];
      },
      listDownloads() {
        return { object: "list", data: [] };
      },
      listEngines() {
        return [];
      },
      listChatSessions() {
        return { object: "list", data: [] };
      },
      listChatMessages() {
        return { object: "list", data: [] };
      },
      upsertChatSession() {
        throw new GatewayRequestError(
          "gateway_stopping",
          "The gateway is shutting down and is not accepting new work.",
          503,
        );
      },
      async runChat() {
        throw new GatewayRequestError(
          "gateway_stopping",
          "The gateway is shutting down and is not accepting new work.",
          503,
        );
      },
      listRecentApiLogs() {
        return { object: "list", data: [] };
      },
      async searchCatalog() {
        return { object: "list", data: [], warnings: [] };
      },
      async getCatalogModel() {
        return {
          object: "model",
          data: {
            id: "huggingface:acme/stage4-chat",
            provider: "huggingface",
            providerModelId: "acme/stage4-chat",
            title: "Stage4 Chat",
            tags: ["gguf"],
            formats: ["gguf"],
            repositoryUrl: "https://example.invalid/acme/stage4-chat",
            variants: [],
          },
          warnings: [],
        };
      },
      async createDownload() {
        throw new GatewayRequestError(
          "resource_exhausted",
          "Not enough resident memory budget to load the requested model.",
          503,
        );
      },
      async pauseDownload() {
        throw new Error("not implemented");
      },
      async resumeDownload() {
        throw new Error("not implemented");
      },
      getHealthSnapshot(plane) {
        return {
          status: "ok",
          plane,
          uptimeMs: 0,
          loadedModelCount: 0,
          activeWebSocketClients: 0,
        };
      },
      async registerLocalModel() {
        throw new Error("not implemented");
      },
      async deleteChatSession() {
        throw new GatewayRequestError(
          "gateway_stopping",
          "The gateway is shutting down and is not accepting new work.",
          503,
        );
      },
      async preloadModel() {
        throw new GatewayRequestError(
          "worker_circuit_open",
          "Model model_qwen25_coder is cooling down after repeated worker failures. Retry in 30s.",
          503,
        );
      },
      async evictModel() {
        throw new Error("not implemented");
      },
      async createChatCompletion() {
        throw new Error("not implemented");
      },
      async createChatCompletionStream() {
        throw new Error("not implemented");
      },
      async createEmbeddings() {
        throw new Error("not implemented");
      },
      recordRequestTrace() {},
    };
    const gateway = await buildGateway({
      config: createTestConfig(),
      runtime,
    });

    await Promise.all([gateway.publicApp.ready(), gateway.controlApp.ready()]);
    activeGateways.push({
      runtime,
      publicApp: gateway.publicApp,
      controlApp: gateway.controlApp,
    });

    const preloadResponse = await gateway.controlApp.inject({
      method: "POST",
      url: "/control/models/preload",
      headers: {
        authorization: "Bearer control-secret",
      },
      payload: {
        modelId: "model_qwen25_coder",
      },
    });
    const downloadResponse = await gateway.controlApp.inject({
      method: "POST",
      url: "/control/downloads",
      headers: {
        authorization: "Bearer control-secret",
      },
      payload: {
        provider: "huggingface",
        providerModelId: "acme/stage4-chat",
        artifactId: "stage4-chat-q4",
        title: "Stage4 Chat",
        artifactName: "stage4-chat-q4.gguf",
        downloadUrl: "https://example.invalid/stage4-chat-q4.gguf",
        metadata: {},
      },
    });

    expect(preloadResponse.statusCode).toBe(503);
    expect(preloadResponse.json()).toMatchObject({
      error: "worker_circuit_open",
    });
    expect(downloadResponse.statusCode).toBe(503);
    expect(downloadResponse.json()).toMatchObject({
      error: "resource_exhausted",
    });
  });
});
