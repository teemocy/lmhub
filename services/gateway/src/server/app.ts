import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";

import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { resolveAppPaths, writeGatewayDiscoveryFile } from "@localhub/platform";
import {
  chatCompletionsRequestSchema,
  desktopChatRunRequestSchema,
  desktopChatSessionUpsertRequestSchema,
  desktopEngineInstallRequestSchema,
  desktopDownloadCreateRequestSchema,
  desktopLocalModelImportRequestSchema,
  desktopModelConfigUpdateRequestSchema,
  embeddingsRequestSchema,
} from "@localhub/shared-contracts";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { WebSocket } from "ws";

import type { GatewayConfig } from "../config.js";
import { MockGatewayRuntime } from "../runtime/mockRuntime.js";
import { createRepositoryGatewayRuntime } from "../runtime/repositoryRuntime.js";
import { type GatewayPlane, GatewayRequestError, type GatewayRuntime } from "../types.js";
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

function sendValidationError(reply: FastifyReply, requestId: string, message: string) {
  return reply.code(400).send({
    error: "validation_error",
    message,
    requestId,
  });
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

export const pipeStreamingResponse = async (
  request: FastifyRequest,
  reply: FastifyReply,
  stream: globalThis.ReadableStream<Uint8Array>,
): Promise<void> => {
  const disconnectError = new Error("Client disconnected.");
  const reader = stream.getReader();
  let cleanedUp = false;

  const cleanup = () => {
    if (cleanedUp) {
      return;
    }

    cleanedUp = true;
    request.raw.off("aborted", handleDisconnect);
    request.raw.off("close", handleDisconnect);
    reply.raw.off("close", handleDisconnect);
  };

  const handleDisconnect = () => {
    if (cleanedUp || reply.raw.destroyed || reply.raw.writableEnded) {
      return;
    }

    void reader.cancel(disconnectError).catch(() => undefined);
    if (!reply.raw.destroyed) {
      reply.raw.destroy(disconnectError);
    }
  };

  request.raw.once("aborted", handleDisconnect);
  request.raw.once("close", handleDisconnect);
  reply.raw.once("close", handleDisconnect);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      if (!reply.raw.write(Buffer.from(value))) {
        await Promise.race([once(reply.raw, "drain"), once(reply.raw, "close")]);
      }
    }

    if (!reply.raw.destroyed && !reply.raw.writableEnded) {
      reply.raw.end();
    }
  } catch (error) {
    if (error instanceof Error && error.message === disconnectError.message) {
      return;
    }

    if (!reply.raw.destroyed) {
      reply.raw.destroy(error instanceof Error ? error : new Error("Streaming response failed."));
    }
  } finally {
    cleanup();
    reader.releaseLock();
  }
};

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

function toGatewayErrorResponse(error: unknown): {
  statusCode: number;
  code: string;
  message: string;
} {
  if (error instanceof GatewayRequestError) {
    return {
      statusCode: error.statusCode,
      code: error.code,
      message: error.message,
    };
  }

  if (isUnknownModelError(error)) {
    return {
      statusCode: 404,
      code: "model_not_found",
      message: error instanceof Error ? error.message : "Unknown model.",
    };
  }

  return {
    statusCode: 500,
    code: "internal_error",
    message: error instanceof Error ? error.message : "Unhandled gateway error.",
  };
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

  app.post("/v1/chat/completions", async (request, reply) => {
    const parsed = chatCompletionsRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: "validation_error",
        message: parsed.error.issues[0]?.message ?? "A valid chat completion request is required.",
        requestId: request.id,
      });
    }

    try {
      if (parsed.data.stream) {
        const result = await runtime.createChatCompletionStream(parsed.data, {
          traceId: request.id,
          remoteAddress:
            request.ip || request.socket?.remoteAddress || request.raw.socket?.remoteAddress,
        });

        reply.hijack();
        reply.raw.statusCode = 200;
        reply.raw.setHeader("content-type", result.contentType);
        reply.raw.setHeader("cache-control", "no-cache, no-transform");
        reply.raw.setHeader("connection", "keep-alive");
        reply.raw.setHeader("x-request-id", request.id);
        pipeStreamingResponse(request, reply, result.stream as globalThis.ReadableStream<Uint8Array>);
        return reply;
      }

      const response = await runtime.createChatCompletion(parsed.data, {
        traceId: request.id,
        remoteAddress:
          request.ip || request.socket?.remoteAddress || request.raw.socket?.remoteAddress,
      });

      return reply.code(200).send(response);
    } catch (error) {
      const formatted = toGatewayErrorResponse(error);
      return reply.code(formatted.statusCode).send({
        error: formatted.code,
        message: formatted.message,
        requestId: request.id,
      });
    }
  });

  app.post("/v1/embeddings", async (request, reply) => {
    const parsed = embeddingsRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: "validation_error",
        message: parsed.error.issues[0]?.message ?? "A valid embeddings request is required.",
        requestId: request.id,
      });
    }

    try {
      const response = await runtime.createEmbeddings(parsed.data, {
        traceId: request.id,
        remoteAddress:
          request.ip || request.socket?.remoteAddress || request.raw.socket?.remoteAddress,
      });

      return reply.code(200).send(response);
    } catch (error) {
      const formatted = toGatewayErrorResponse(error);
      return reply.code(formatted.statusCode).send({
        error: formatted.code,
        message: formatted.message,
        requestId: request.id,
      });
    }
  });
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
      const formatted = toGatewayErrorResponse(error);
      return reply.code(formatted.code === "internal_error" ? 400 : formatted.statusCode).send({
        error: formatted.code === "internal_error" ? "invalid_artifact" : formatted.code,
        message:
          formatted.code === "internal_error"
            ? error instanceof Error
              ? error.message
              : "The selected local artifact could not be read."
            : formatted.message,
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
      if (error instanceof GatewayRequestError || isUnknownModelError(error)) {
        const formatted = toGatewayErrorResponse(error);
        return reply.code(formatted.statusCode).send({
          error: formatted.code,
          message: formatted.message,
          requestId: request.id,
        });
      }

      return reply.code(409).send({
        error: "model_load_failed",
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
      if (error instanceof GatewayRequestError || isUnknownModelError(error)) {
        const formatted = toGatewayErrorResponse(error);
        return reply.code(formatted.statusCode).send({
          error: formatted.code,
          message: formatted.message,
          requestId: request.id,
        });
      }

      return reply.code(409).send({
        error: "model_evict_failed",
        message: error instanceof Error ? error.message : "The model could not be evicted.",
        requestId: request.id,
      });
    }
  });

  app.put("/config/models/*", async (request, reply) => {
    const rawModelId = (request.params as { "*": string | undefined })["*"];
    const modelId = rawModelId?.trim();
    if (!modelId) {
      return reply.code(400).send({
        error: "validation_error",
        message: "modelId is required.",
        requestId: request.id,
      });
    }

    try {
      const parsed = desktopModelConfigUpdateRequestSchema.parse(request.body ?? {});
      return await runtime.updateModelConfig(modelId, parsed, request.id);
    } catch (error) {
      if (error instanceof GatewayRequestError) {
        return reply.code(error.statusCode).send({
          error: error.code,
          message: error.message,
          requestId: request.id,
        });
      }

      return reply.code(400).send({
        error: "validation_error",
        message: error instanceof Error ? error.message : "Unable to update model configuration.",
        requestId: request.id,
      });
    }
  });

  app.get("/control/chat/sessions", async () => runtime.listChatSessions());

  app.get("/control/chat/messages", async (request, reply) => {
    const rawSessionId = (request.query as { sessionId?: unknown }).sessionId;
    const sessionId = typeof rawSessionId === "string" ? rawSessionId.trim() : "";
    if (sessionId.length === 0) {
      return reply.code(400).send({
        error: "validation_error",
        message: "sessionId is required.",
        requestId: request.id,
      });
    }

    return runtime.listChatMessages(sessionId);
  });

  app.post("/control/chat/sessions", async (request, reply) => {
    const parsed = desktopChatSessionUpsertRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return sendValidationError(
        reply,
        request.id,
        parsed.error.issues[0]?.message ?? "Invalid chat session payload.",
      );
    }

    return runtime.upsertChatSession(parsed.data);
  });

  app.delete("/control/chat/sessions/:sessionId", async (request, reply) => {
    const rawSessionId = (request.params as { sessionId?: unknown }).sessionId;
    const sessionId = typeof rawSessionId === "string" ? rawSessionId.trim() : "";
    if (sessionId.length === 0) {
      return sendValidationError(reply, request.id, "sessionId is required.");
    }

    const deleted = await runtime.deleteChatSession(sessionId);
    if (!deleted) {
      return reply.code(404).send({
        error: "not_found",
        message: `Chat session ${sessionId} was not found.`,
        requestId: request.id,
      });
    }

    return reply.code(204).send();
  });

  app.post("/control/chat/run", async (request, reply) => {
    const parsed = desktopChatRunRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return sendValidationError(
        reply,
        request.id,
        parsed.error.issues[0]?.message ?? "Invalid chat run payload.",
      );
    }

    return runtime.runChat(parsed.data, request.id);
  });

  app.post("/control/chat/run/stream", async (request, reply) => {
    const parsed = desktopChatRunRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return sendValidationError(
        reply,
        request.id,
        parsed.error.issues[0]?.message ?? "Invalid chat run payload.",
      );
    }

    const result = await runtime.runChatStream(parsed.data, request.id);

    reply.hijack();
    reply.raw.statusCode = 200;
    reply.raw.setHeader("content-type", result.contentType);
    reply.raw.setHeader("cache-control", "no-cache, no-transform");
    reply.raw.setHeader("connection", "keep-alive");
    reply.raw.setHeader("x-request-id", request.id);
    reply.raw.setHeader("x-localhub-session-id", result.session.id);
    reply.raw.setHeader("x-localhub-user-message-id", result.userMessageId);
    reply.raw.setHeader("x-localhub-assistant-message-id", result.assistantMessageId);
    pipeStreamingResponse(request, reply, result.stream as globalThis.ReadableStream<Uint8Array>);
    return reply;
  });

  app.get("/control/observability/api-logs", async (request) => {
    const rawLimit = (request.query as { limit?: unknown }).limit;
    const limit =
      typeof rawLimit === "number"
        ? rawLimit
        : typeof rawLimit === "string"
          ? Number.parseInt(rawLimit, 10)
          : 30;
    return runtime.listRecentApiLogs(Number.isFinite(limit) && limit > 0 ? limit : 30);
  });

  app.get("/control/downloads", async (request, reply) => {
    const queryParams = request.query as {
      q?: unknown;
      provider?: unknown;
      providerModelId?: unknown;
    };
    const rawQuery = queryParams.q;
    const query = typeof rawQuery === "string" ? rawQuery.trim() : "";
    const provider = typeof queryParams.provider === "string" ? queryParams.provider.trim() : "";
    const providerModelId =
      typeof queryParams.providerModelId === "string" ? queryParams.providerModelId.trim() : "";

    if (query.length > 0) {
      return runtime.searchCatalog(query);
    }

    if (provider.length > 0 || providerModelId.length > 0) {
      if (
        (provider !== "huggingface" && provider !== "modelscope") ||
        providerModelId.length === 0
      ) {
        return reply.code(400).send({
          error: "validation_error",
          message: "provider and providerModelId are required for catalog details.",
          requestId: request.id,
        });
      }

      return runtime.getCatalogModel(provider, providerModelId);
    }

    return runtime.listDownloads();
  });

  app.post("/control/downloads", async (request, reply) => {
    const payload = (request.body ?? {}) as Record<string, unknown>;
    const action = typeof payload.action === "string" ? payload.action : "create";

    if (action === "pause") {
      if (typeof payload.id !== "string" || payload.id.trim().length === 0) {
        return reply.code(400).send({
          error: "invalid_request",
          message: "Download id is required for pause.",
          requestId: request.id,
        });
      }

      return reply.code(202).send(await runtime.pauseDownload(payload.id, request.id));
    }

    if (action === "resume") {
      if (typeof payload.id !== "string" || payload.id.trim().length === 0) {
        return reply.code(400).send({
          error: "invalid_request",
          message: "Download id is required for resume.",
          requestId: request.id,
        });
      }

      return reply.code(202).send(await runtime.resumeDownload(payload.id, request.id));
    }

    const parsed = desktopDownloadCreateRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return sendValidationError(
        reply,
        request.id,
        parsed.error.issues[0]?.message ?? "Invalid download payload.",
      );
    }

    try {
      return reply.code(202).send(await runtime.createDownload(parsed.data, request.id));
    } catch (error) {
      const formatted = toGatewayErrorResponse(error);
      return reply.code(formatted.statusCode).send({
        error: formatted.code,
        message: formatted.message,
        requestId: request.id,
      });
    }
  });

  app.get("/control/engines", async () => ({
    object: "list",
    data: runtime.listEngines(),
  }));

  app.post("/control/engines", async (request, reply) => {
    const parsed = desktopEngineInstallRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return sendValidationError(
        reply,
        request.id,
        parsed.error.issues[0]?.message ?? "Invalid engine install payload.",
      );
    }

    try {
      return reply.code(202).send(await runtime.installEngineBinary(parsed.data, request.id));
    } catch (error) {
      const formatted = toGatewayErrorResponse(error);
      return reply.code(formatted.statusCode).send({
        error: formatted.code,
        message: formatted.message,
        requestId: request.id,
      });
    }
  });

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
    localModelsDir: config.localModelsDir,
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
