import { type GatewayEvent, gatewayEventSchema } from "@localhub/shared-contracts";
import { afterEach, describe, expect, it } from "vitest";

import type { GatewayConfig } from "../src/config.js";
import { MockGatewayRuntime } from "../src/runtime/mockRuntime.js";
import { buildGateway } from "../src/server/app.js";

interface TestGateway {
  runtime: MockGatewayRuntime;
  publicApp: Awaited<ReturnType<typeof buildGateway>>["publicApp"];
  controlApp: Awaited<ReturnType<typeof buildGateway>>["controlApp"];
}

const activeGateways: TestGateway[] = [];

function createTestConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
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
});
