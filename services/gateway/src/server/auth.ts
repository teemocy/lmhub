import type { FastifyReply, FastifyRequest } from "fastify";

function getRequestPath(request: FastifyRequest): string {
  return new URL(request.raw.url ?? "/", "http://localhost").pathname;
}

function sendUnauthorized(reply: FastifyReply, realm: string, requestId: string): void {
  reply.code(401).header("www-authenticate", `Bearer realm="${realm}"`).send({
    error: "unauthorized",
    message: "Missing or invalid bearer token.",
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

    const authorization = request.headers.authorization;
    const [scheme, credential] = authorization?.split(/\s+/, 2) ?? [];
    if (scheme?.toLowerCase() !== "bearer" || credential !== options.token) {
      sendUnauthorized(reply, options.realm, request.id);
    }
  };
}
