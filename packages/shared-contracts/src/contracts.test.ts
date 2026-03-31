import { describe, expect, it } from "vitest";

import {
  chatCompletionsRequestSchema,
  gatewayDiscoveryFileSchema,
  gatewayEventSchema,
  gatewayHealthSnapshotSchema,
  runtimeKeySchema,
} from "./index.js";

describe("shared contracts", () => {
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
