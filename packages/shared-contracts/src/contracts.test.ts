import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  chatCompletionsChunkSchema,
  chatCompletionsRequestSchema,
  chatCompletionsResponseSchema,
  deserializeGatewayEvent,
  deserializeRequestTrace,
  deserializeToolCalls,
  desktopChatRunRequestSchema,
  desktopDownloadCreateRequestSchema,
  desktopProviderSearchItemSchema,
  downloadTaskSchema,
  embeddingsRequestSchema,
  embeddingsResponseSchema,
  gatewayDiscoveryFileSchema,
  gatewayEventSchema,
  gatewayHealthSnapshotSchema,
  modelArtifactSchema,
  modelProfileSchema,
  openAiModelListSchema,
  openAiToolCallSchema,
  requestTraceSchema,
  rerankRequestSchema,
  rerankResponseSchema,
  runtimeKeySchema,
  serializeGatewayEvent,
  serializeRequestTrace,
  serializeToolCalls,
  workerStateSchema,
} from "./index.js";

function loadFixture(fileName: string): unknown {
  return JSON.parse(
    readFileSync(path.resolve(import.meta.dirname, "../fixtures", fileName), "utf8"),
  ) as unknown;
}

describe("shared contracts", () => {
  it("parses the stage 2 model artifact fixture", () => {
    const artifact = modelArtifactSchema.parse(
      loadFixture("foundation-model-artifact.sample.json"),
    );

    expect(artifact.id).toBe("model_qwen25_coder");
    expect(artifact.metadata.contextLength).toBe(32768);
  });

  it("parses the stage 2 model profile fixture", () => {
    const profile = modelProfileSchema.parse(loadFixture("foundation-model-profile.sample.json"));

    expect(profile.modelId).toBe("model_qwen25_coder");
    expect(profile.engineType).toBe("llama.cpp");
  });

  it("parses the stage 2 runtime fixtures", () => {
    const runtimeKey = runtimeKeySchema.parse(loadFixture("foundation-runtime-key.sample.json"));
    const workerState = workerStateSchema.parse(loadFixture("foundation-worker-state.sample.json"));

    expect(runtimeKey.engineType).toBe("llama.cpp");
    expect(workerState.runtimeKeyString).toContain("llama.cpp");
  });

  it("parses the stage 2 download task fixture", () => {
    const task = downloadTaskSchema.parse(loadFixture("foundation-download-task.sample.json"));

    expect(task.status).toBe("downloading");
    expect(task.metadata.fileName).toBe("model.gguf");
  });

  it("parses the stage 2 gateway event fixture", () => {
    const event = gatewayEventSchema.parse(loadFixture("foundation-gateway-event.sample.json"));

    expect(event.type).toBe("MODEL_STATE_CHANGED");
    expect(event.payload.runtimeKey.engineType).toBe("llama.cpp");
  });

  it("parses the stage 3 chat completions fixtures", () => {
    const request = chatCompletionsRequestSchema.parse(
      loadFixture("openai-chat-completions-request.sample.json"),
    );
    const response = chatCompletionsResponseSchema.parse(
      loadFixture("openai-chat-completions-response.sample.json"),
    );
    const chunk = chatCompletionsChunkSchema.parse(
      loadFixture("openai-chat-completion-chunk.sample.json"),
    );

    expect(request.model).toBe("model_qwen25_coder");
    expect(response.object).toBe("chat.completion");
    expect(chunk.object).toBe("chat.completion.chunk");
  });

  it("parses the stage 3 embeddings fixtures", () => {
    const request = embeddingsRequestSchema.parse(
      loadFixture("openai-embeddings-request.sample.json"),
    );
    const response = embeddingsResponseSchema.parse(
      loadFixture("openai-embeddings-response.sample.json"),
    );

    expect(request.model).toBe("model_bge_small_en");
    expect(response.data).toHaveLength(1);
  });

  it("parses rerank request and response payloads", () => {
    const request = rerankRequestSchema.parse({
      model: "model_jina_reranker",
      query: "Which section explains interconnect responsibilities?",
      documents: [
        "Snoop transactions use the snoop address, snoop response, and snoop data channels.",
        {
          text: "It is the responsibility of the interconnect to receive transactions and generate the response for the initiating master.",
        },
      ],
      top_n: 2,
      normalize: true,
    });
    const response = rerankResponseSchema.parse({
      object: "list",
      model: "model_jina_reranker",
      usage: {
        prompt_tokens: 42,
        total_tokens: 42,
      },
      results: [
        {
          index: 1,
          relevance_score: 0.91,
        },
        {
          index: 0,
          relevance_score: 0.12,
        },
      ],
    });

    expect(request.documents).toHaveLength(2);
    expect(response.results[0]?.index).toBe(1);
  });

  it("parses the stage 3 request-trace and model-list fixtures", () => {
    const trace = requestTraceSchema.parse(loadFixture("foundation-request-trace.sample.json"));
    const modelList = openAiModelListSchema.parse(loadFixture("openai-model-list.sample.json"));

    expect(trace.route).toBe("POST /v1/chat/completions");
    expect(modelList.data[0]?.object).toBe("model");
    expect(modelList.data[0]?.model_id).toBe("model_qwen25_coder");
  });

  it("round-trips tool calls, gateway events, and request traces", () => {
    const toolCalls = openAiToolCallSchema.array().parse([
      {
        id: "call_weather",
        type: "function",
        function: {
          name: "lookup_weather",
          arguments: '{"location":"Shanghai"}',
        },
      },
    ]);
    const event = gatewayEventSchema.parse(loadFixture("foundation-gateway-event.sample.json"));
    const trace = requestTraceSchema.parse(loadFixture("foundation-request-trace.sample.json"));

    expect(deserializeToolCalls(serializeToolCalls(toolCalls))).toEqual(toolCalls);
    expect(deserializeGatewayEvent(serializeGatewayEvent(event))).toEqual(event);
    expect(deserializeRequestTrace(serializeRequestTrace(trace))).toEqual(trace);
  });

  it("keeps provider search items round-trippable into create-download requests", () => {
    const item = desktopProviderSearchItemSchema.parse({
      id: "huggingface:acme/stage3-gateway-chat",
      provider: "huggingface",
      providerModelId: "acme/stage3-gateway-chat",
      title: "Gateway Stage3 Chat",
      repositoryUrl: "https://example.invalid/acme/stage3-gateway-chat",
    });

    const createRequest = desktopDownloadCreateRequestSchema.parse({
      provider: item.provider,
      providerModelId: item.providerModelId,
      artifactId: "gateway-stage3-chat-q4",
      title: item.title,
      artifactName: "gateway-stage3-chat-q4.gguf",
      metadata: {},
      files: [
        {
          artifactId: "gateway-stage3-chat-q4",
          artifactName: "gateway-stage3-chat-q4.gguf",
          downloadUrl: "https://example.invalid/artifacts/gateway-stage3-chat-q4.gguf",
          metadata: {},
        },
      ],
    });

    expect(createRequest.providerModelId).toBe("acme/stage3-gateway-chat");
    expect(createRequest.artifactId).toBe("gateway-stage3-chat-q4");
    expect(createRequest.files?.length).toBe(1);
    expect(item.id).not.toBe(item.providerModelId);
  });

  it("parses a gateway event envelope", () => {
    const runtimeKey = runtimeKeySchema.parse({
      modelId: "qwen2.5-coder",
      engineType: "llama.cpp",
      role: "chat",
      configHash: "cfg_1234",
    });

    const event = gatewayEventSchema.parse({
      type: "MODEL_STATE_CHANGED",
      ts: "2026-03-31T12:00:00.000Z",
      traceId: "trace_12345678",
      payload: {
        modelId: "qwen2.5-coder",
        runtimeKey,
        nextState: "Ready",
      },
    });

    expect(event.payload.nextState).toBe("Ready");
  });

  it("validates the discovery file contract", () => {
    const discovery = gatewayDiscoveryFileSchema.parse({
      environment: "development",
      gatewayVersion: "0.1.0",
      generatedAt: "2026-03-31T12:00:00.000Z",
      publicBaseUrl: "http://127.0.0.1:1337",
      controlBaseUrl: "http://127.0.0.1:16384",
      websocketUrl: "ws://127.0.0.1:16384/ws",
      supportRoot: "/tmp/local-llm-hub/dev",
    });

    expect(discovery.publicBaseUrl).toContain("1337");
  });

  it("accepts the v1 chat completion request skeleton", () => {
    const request = chatCompletionsRequestSchema.parse({
      model: "qwen2.5-coder",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
      extra_body: {
        localhub: {
          prompt_cache_key: "cache_123",
        },
      },
    });

    expect(request.stream).toBe(true);
  });

  it("accepts multimodal chat request payloads", () => {
    const content = [
      {
        type: "text",
        text: "Describe this image.",
      },
      {
        type: "image_url",
        image_url: {
          url: "data:image/png;base64,AAAA",
        },
      },
    ];

    const openAiRequest = chatCompletionsRequestSchema.parse({
      model: "qwen2.5-vl-7b-instruct-q4",
      messages: [{ role: "user", content }],
      stream: false,
    });
    const desktopRequest = desktopChatRunRequestSchema.parse({
      model: "qwen2.5-vl-7b-instruct-q4",
      message: content,
    });

    expect(Array.isArray(openAiRequest.messages[0]?.content)).toBe(true);
    expect(Array.isArray(desktopRequest.message)).toBe(true);
  });

  it("keeps health snapshots URL-safe", () => {
    const snapshot = gatewayHealthSnapshotSchema.parse({
      state: "ready",
      publicBaseUrl: "http://127.0.0.1:1337",
      controlBaseUrl: "http://127.0.0.1:16384",
      uptimeMs: 100,
      activeWorkers: 0,
      queuedRequests: 0,
      generatedAt: "2026-03-31T12:00:00.000Z",
    });

    expect(snapshot.state).toBe("ready");
  });
});
