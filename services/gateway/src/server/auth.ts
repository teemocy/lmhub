import type { FastifyReply, FastifyRequest } from "fastify";

function getRequestPath(request: FastifyRequest): string {
  return new URL(request.raw.url ?? "/", "http://localhost").pathname;
}

function getHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const normalized = item.trim();
      if (normalized.length > 0) {
        return normalized;
      }
    }

    return undefined;
  }

  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function getRequestToken(request: FastifyRequest): string | undefined {
  const authorization = getHeaderValue(request.headers.authorization);
  if (authorization) {
    const [scheme, credential] = authorization.split(/\s+/, 2);
    const normalizedScheme = scheme?.toLowerCase();

    if (
      normalizedScheme === "bearer" ||
      normalizedScheme === "apikey" ||
      normalizedScheme === "api-key"
    ) {
      return credential?.trim();
    }
  }

  return getHeaderValue(request.headers["x-api-key"]) ?? getHeaderValue(request.headers["api-key"]);
}

function sendUnauthorized(reply: FastifyReply, realm: string, requestId: string): void {
  reply.code(401).header("www-authenticate", `Bearer realm="${realm}"`).send({
    error: "unauthorized",
    message: "Missing or invalid bearer token or API key.",
    requestId,
  });
}

export function createBearerAuthHook(options: {
  token: string | undefined;
  realm: string;
  openPaths?: string[];
}) {
  const openPaths = new Set(options.openPaths ?? []);

  return async function bearerAuthHook(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    if (!options.token || request.method === "OPTIONS") {
      return;
    }

    if (openPaths.has(getRequestPath(request))) {
      return;
    }

    const credential = getRequestToken(request);
    if (credential !== options.token) {
      sendUnauthorized(reply, options.realm, request.id);
    }
  };
}
