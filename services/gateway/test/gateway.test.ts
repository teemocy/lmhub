import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { type GatewayEvent, gatewayEventSchema } from "@localhub/shared-contracts";
import { afterEach, describe, expect, it } from "vitest";

import type { GatewayConfig } from "../src/config.js";
import { MockGatewayRuntime } from "../src/runtime/mockRuntime.js";
import { buildGateway, stopGatewayServices } from "../src/server/app.js";
import type { GatewayRuntime } from "../src/types.js";

interface TestGateway {
  runtime: MockGatewayRuntime;
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
          id: "localhub/tinyllama-1.1b-chat-q4",
        }),
      ]),
    });
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
});
