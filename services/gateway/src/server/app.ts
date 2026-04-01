import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";

import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { resolveAppPaths, writeGatewayDiscoveryFile } from "@localhub/platform";
import { desktopLocalModelImportRequestSchema } from "@localhub/shared-contracts";
import Fastify, { type FastifyInstance } from "fastify";
import { WebSocket } from "ws";

import type { GatewayConfig } from "../config.js";
import { MockGatewayRuntime } from "../runtime/mockRuntime.js";
import { createRepositoryGatewayRuntime } from "../runtime/repositoryRuntime.js";
import type { GatewayPlane, GatewayRuntime } from "../types.js";
import { createBearerAuthHook } from "./auth.js";
import { createLoopbackOnlyHook, getRequestPath, isOriginAllowed } from "./network.js";

interface BuildGatewayOptions {
  config: GatewayConfig;
  runtime?: GatewayRuntime;
  requestShutdown?: () => Promise<void> | void;
}

export interface StartedGateway {
  publicAddress: string;
  controlAddress: string;
  publicApp: FastifyInstance;
  controlApp: FastifyInstance;
  runtime: GatewayRuntime;
  stop: () => Promise<void>;
}

interface GatewayStoppables {
  publicApp: Pick<FastifyInstance, "close">;
  controlApp: Pick<FastifyInstance, "close">;
  runtime: Pick<GatewayRuntime, "stop">;
}

export async function stopGatewayServices(
  gateway: GatewayStoppables,
  discoveryFile: string,
): Promise<void> {
  await Promise.allSettled([
    gateway.runtime.stop(),
    gateway.publicApp.close(),
    gateway.controlApp.close(),
  ]);
  await rm(discoveryFile, { force: true });
}

function createApp(): FastifyInstance {
  return Fastify({
    logger: false,
    requestIdHeader: "x-request-id",
    genReqId: (request) => {
      const header = request.headers["x-request-id"];
      if (typeof header === "string" && header.trim().length > 0) {
        return header.trim();
      }

      return randomUUID();
    },
  });
}

function registerLifecycleHooks(
  app: FastifyInstance,
  runtime: GatewayRuntime,
  plane: GatewayPlane,
): void {
  const requestStartedAt = new Map<string, number>();

  app.addHook("onRequest", async (request, reply) => {
    requestStartedAt.set(request.id, Date.now());
    reply.header("x-request-id", request.id);
  });

  app.addHook("onResponse", async (request, reply) => {
    const startedAt = requestStartedAt.get(request.id) ?? Date.now();
    requestStartedAt.delete(request.id);
    runtime.recordRequestTrace({
      requestId: request.id,
      plane,
      method: request.method,
      path: getRequestPath(request),
      statusCode: reply.statusCode,
      durationMs: Date.now() - startedAt,
      remoteAddress:
        request.ip || request.socket?.remoteAddress || request.raw.socket?.remoteAddress,
    });
  });

  app.addHook("onClose", async () => {
    requestStartedAt.clear();
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      error: "not_found",
      message: `Route ${getRequestPath(request)} was not found.`,
      requestId: request.id,
    });
  });

  app.setErrorHandler((error, request, reply) => {
    if (reply.sent) {
      return;
    }

    reply.code(500).send({
      error: "internal_error",
      message: error instanceof Error ? error.message : "Unhandled gateway error.",
      requestId: request.id,
    });
  });
}

function isUnknownModelError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("Unknown model:");
}

async function registerPublicApp(
  app: FastifyInstance,
  config: GatewayConfig,
  runtime: GatewayRuntime,
): Promise<void> {
  registerLifecycleHooks(app, runtime, "public");

  await app.register(cors, {
    credentials: true,
    exposedHeaders: ["x-request-id"],
    origin: (origin, callback) => {
      callback(null, isOriginAllowed(origin, config.corsAllowlist));
    },
  });

  app.addHook(
    "onRequest",
    createBearerAuthHook({
      token: config.publicBearerToken,
      realm: "gateway-public",
      openPaths: ["/healthz"],
    }),
  );

  app.get("/healthz", async () => runtime.getHealthSnapshot("public"));

  app.get("/v1/models", async () => ({
    object: "list",
    data: runtime.listModels(),
  }));
}

async function registerControlApp(
  app: FastifyInstance,
  config: GatewayConfig,
  runtime: GatewayRuntime,
  requestShutdown?: () => Promise<void> | void,
): Promise<void> {
  registerLifecycleHooks(app, runtime, "control");

  await app.register(websocket);

  app.addHook("onRequest", createLoopbackOnlyHook(["/healthz"]));
  app.addHook(
    "onRequest",
    createBearerAuthHook({
      token: config.controlBearerToken,
      realm: "gateway-control",
      openPaths: ["/healthz"],
    }),
  );

  app.get("/healthz", async () => runtime.getHealthSnapshot("control"));

  app.get("/control/health", async () => runtime.getHealthSnapshot("control"));

  app.get("/control/models", async () => ({
    object: "list",
    data: await runtime.listDesktopModels(),
  }));

  app.post("/control/models/register-local", async (request, reply) => {
    const parsed = desktopLocalModelImportRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: "validation_error",
        message: parsed.error.issues[0]?.message ?? "A local GGUF path is required.",
        requestId: request.id,
      });
    }

    try {
      const result = await runtime.registerLocalModel(parsed.data, request.id);
      return reply.code(result.created ? 201 : 200).send(result);
    } catch (error) {
      return reply.code(400).send({
        error: "invalid_artifact",
        message:
          error instanceof Error ? error.message : "The selected local artifact could not be read.",
        requestId: request.id,
      });
    }
  });

  app.post<{ Body: { modelId?: string } }>("/control/models/preload", async (request, reply) => {
    const modelId = request.body?.modelId?.trim();
    if (!modelId) {
      return reply.code(400).send({
        error: "validation_error",
        message: "modelId is required.",
        requestId: request.id,
      });
    }

    try {
      const result = await runtime.preloadModel(modelId, request.id);
      return reply.code(202).send({
        accepted: true,
        alreadyWarm: result.alreadyWarm,
        model: result.model,
      });
    } catch (error) {
      const statusCode = isUnknownModelError(error) ? 404 : 409;
      return reply.code(statusCode).send({
        error: statusCode === 404 ? "model_not_found" : "model_load_failed",
        message:
          error instanceof Error ? error.message : "The model could not be loaded into memory.",
        requestId: request.id,
      });
    }
  });

  app.post<{ Body: { modelId?: string } }>("/control/models/evict", async (request, reply) => {
    const modelId = request.body?.modelId?.trim();
    if (!modelId) {
      return reply.code(400).send({
        error: "validation_error",
        message: "modelId is required.",
        requestId: request.id,
      });
    }

    try {
      const result = await runtime.evictModel(modelId, request.id);
      return reply.code(202).send({
        accepted: true,
        wasLoaded: result.wasLoaded,
        model: result.model,
      });
    } catch (error) {
      const statusCode = isUnknownModelError(error) ? 404 : 409;
      return reply.code(statusCode).send({
        error: statusCode === 404 ? "model_not_found" : "model_evict_failed",
        message: error instanceof Error ? error.message : "The model could not be evicted.",
        requestId: request.id,
      });
    }
  });

  app.get("/control/downloads", async () => ({
    data: runtime.listDownloads(),
  }));

  app.post("/control/downloads", async (_request, reply) =>
    reply.code(202).send({
      accepted: true,
      message: "Mock download scheduling is wired for Stage 1.",
    }),
  );

  app.get("/control/engines", async () => ({
    object: "list",
    data: runtime.listEngines(),
  }));

  app.post("/control/engines", async (_request, reply) =>
    reply.code(202).send({
      accepted: true,
      message: "Mock engine management is wired for Stage 1.",
    }),
  );

  app.post("/control/system/shutdown", async (_request, reply) => {
    const response = {
      accepted: true,
      message: "Gateway shutdown requested.",
    };

    if (requestShutdown) {
      setImmediate(() => {
        void requestShutdown();
      });
    }

    return reply.code(202).send(response);
  });

  app.get("/control/events", { websocket: true }, (socket) => {
    const unsubscribe = runtime.subscribe((event) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(event));
      }
    });

    socket.on("close", unsubscribe);
    socket.on("error", unsubscribe);
  });
}

function getBoundAddress(address: string | AddressInfo | null): string {
  if (typeof address === "string") {
    return address;
  }

  if (!address) {
    throw new Error("Listener address is unavailable.");
  }

  return `http://${address.address}:${address.port}`;
}

export async function buildGateway(options: BuildGatewayOptions): Promise<{
  publicApp: FastifyInstance;
  controlApp: FastifyInstance;
  runtime: GatewayRuntime;
}> {
  const runtime =
    options.runtime ??
    new MockGatewayRuntime({
      telemetryIntervalMs: options.config.telemetryIntervalMs,
    });

  const publicApp = createApp();
  const controlApp = createApp();

  await registerPublicApp(publicApp, options.config, runtime);
  await registerControlApp(controlApp, options.config, runtime, options.requestShutdown);

  return {
    publicApp,
    controlApp,
    runtime,
  };
}

export async function startGateway(
  config: GatewayConfig,
  runtime: GatewayRuntime = createRepositoryGatewayRuntime({
    cwd: process.cwd(),
    defaultModelTtlMs: config.defaultModelTtlMs,
    telemetryIntervalMs: config.telemetryIntervalMs,
  }),
): Promise<StartedGateway> {
  let stopPromise: Promise<void> | undefined;
  const appPaths = resolveAppPaths({
    cwd: process.cwd(),
  });

  const gateway = await buildGateway({
    config,
    runtime,
    requestShutdown: async () => {
      await stop();
    },
  });

  await gateway.runtime.start();

  const stop = async (): Promise<void> => {
    if (stopPromise) {
      return stopPromise;
    }

    stopPromise = (async () => {
      await stopGatewayServices(gateway, appPaths.discoveryFile);
    })();

    return stopPromise;
  };

  try {
    await gateway.controlApp.listen({
      host: config.controlHost,
      port: config.controlPort,
    });

    await gateway.publicApp.listen({
      host: config.publicHost,
      port: config.publicPort,
    });
  } catch (error) {
    await stop();
    throw error;
  }

  const publicAddress = getBoundAddress(gateway.publicApp.server.address());
  const controlAddress = getBoundAddress(gateway.controlApp.server.address());

  writeGatewayDiscoveryFile(appPaths.discoveryFile, {
    schemaVersion: 1,
    environment: appPaths.environment,
    gatewayVersion: process.env.npm_package_version ?? "0.1.0",
    generatedAt: new Date().toISOString(),
    publicBaseUrl: publicAddress,
    controlBaseUrl: controlAddress,
    websocketUrl: `${controlAddress.replace(/^http/, "ws")}/control/events`,
    pid: process.pid,
    supportRoot: appPaths.supportRoot,
  });

  return {
    ...gateway,
    publicAddress,
    controlAddress,
    stop,
  };
}
