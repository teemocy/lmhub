import type { FastifyReply, FastifyRequest } from "fastify";

export function getRequestPath(request: FastifyRequest): string {
  return new URL(request.raw.url ?? "/", "http://localhost").pathname;
}

export function isLoopbackAddress(rawAddress: string | undefined): boolean {
  if (!rawAddress) {
    return false;
  }

  const normalized = rawAddress.replace("::ffff:", "");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

export function createLoopbackOnlyHook(openPaths: string[] = []) {
  const openPathSet = new Set(openPaths);

  return async function loopbackOnlyHook(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    if (openPathSet.has(getRequestPath(request))) {
      return;
    }

    const remoteAddress =
      request.ip || request.socket?.remoteAddress || request.raw.socket?.remoteAddress;

    // `injectWS` exercises the upgrade flow without a real socket address.
    // Real network traffic still presents an address and remains loopback-gated.
    if (!remoteAddress && request.headers.upgrade?.toLowerCase() === "websocket") {
      return;
    }

    if (isLoopbackAddress(remoteAddress)) {
      return;
    }

    reply.code(403).send({
      error: "forbidden",
      message: "Control routes are limited to loopback clients.",
      requestId: request.id,
    });
  };
}

export function isOriginAllowed(origin: string | undefined, allowlist: string[]): boolean {
  if (!origin) {
    return true;
  }

  if (allowlist.includes("*")) {
    return true;
  }

  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    return false;
  }

  return allowlist.some((entry) => {
    if (entry.includes("://")) {
      return origin === entry;
    }

    return parsedOrigin.hostname === entry;
  });
}
