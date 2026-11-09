import { createMcpHandler } from "agents/mcp/server";
import { refreshPerformance } from "./services/performance-refresh";
import type { Env, Identity } from "./config/env";
import { AppError, errorResult, id } from "./domain/errors";
import { authenticate } from "./mcp/auth";
import { createServer } from "./mcp/server";
import { createOAuthProvider, oauthIdentity } from "./mcp/oauth";
import {
  allowedOrigins,
  checkOrigin,
  corsResponse,
  preflight,
} from "./mcp/origins";
async function serveMcp(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  identity: Identity,
): Promise<Response> {
  if (request.method === "POST") {
    if (!request.headers.get("Content-Type")?.includes("application/json"))
      return new Response("Expected application/json", { status: 415 });
    const size = Number(request.headers.get("Content-Length") ?? "0");
    if (size > 65536) return new Response("Request too large", { status: 413 });
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (reader) {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > 65536) {
          await reader.cancel();
          return new Response("Request too large", { status: 413 });
        }
        chunks.push(value);
      }
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const text = new TextDecoder().decode(bytes);
    request = new Request(request, { body: text });
  }
  return await createMcpHandler(() => createServer(env, identity), {
    corsOptions: false,
    // Exact Origin validation is performed before authentication.
    allowedOriginHostnames: [
      ...new Set(
        allowedOrigins(request, env).map((origin) => new URL(origin).hostname),
      ),
    ],
  })(request, env, ctx);
}
export default {
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ) {
    ctx.waitUntil(refreshPerformance(env));
  },
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/health" && request.method === "GET")
      return Response.json({
        status: "ok",
        service: "x-content-intelligence",
        version: "2.0.0",
      });
    try {
      if (path === "/mcp") {
        checkOrigin(request, env);
        if (request.method === "OPTIONS") return preflight(request, env);
      }
      // Publish contracts for clients that discover before linking an account.
      // Tool execution always goes through authentication below.
      if (
        path === "/mcp" &&
        request.method === "POST" &&
        !request.headers.has("Authorization")
      ) {
        const reader = request.body?.getReader();
        let size = 0;
        const chunks: Uint8Array[] = [];
        if (reader)
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 65536) {
              await reader.cancel();
              return new Response("Request too large", { status: 413 });
            }
            chunks.push(value);
          }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        const text = new TextDecoder().decode(bytes);
        request = new Request(request, { body: text });
        let method: unknown;
        try {
          const message: unknown = JSON.parse(text);
          if (message && typeof message === "object" && !Array.isArray(message))
            method = (message as { method?: unknown }).method;
        } catch {
          /* Invalid/unknown requests stay protected. */
        }
        if (
          typeof method === "string" &&
          [
            "initialize",
            "tools/list",
            "ping",
            "notifications/initialized",
          ].includes(method)
        ) {
          return corsResponse(
            await serveMcp(request, env, ctx, {
              ownerId: "anonymous-discovery",
              scopes: new Set(),
            }),
            request,
            env,
          );
        }
      }
      if (path === "/mcp" && request.headers.has("Authorization")) {
        // Preserve direct-token clients; OAuth tokens are verified by the provider below.
        let identity: Identity | undefined;
        try {
          identity = await authenticate(request, env);
        } catch {
          /* Not the personal bearer token. */
        }
        if (identity)
          return corsResponse(
            await serveMcp(request, env, ctx, identity),
            request,
            env,
          );
      }
      const provider = createOAuthProvider(
        request,
        env,
        (req, bindings, oauthCtx) =>
          serveMcp(req, bindings, oauthCtx, oauthIdentity(bindings, oauthCtx)),
      );
      const response = await provider.fetch(request, env, ctx);
      return path === "/mcp" ? corsResponse(response, request, env) : response;
    } catch (error) {
      return Response.json(errorResult(error, id("req")), {
        status:
          error instanceof AppError && error.code === "FORBIDDEN"
            ? 403
            : error instanceof AppError && error.code === "UNAUTHORIZED"
              ? 401
              : 500,
        headers: { "Cache-Control": "no-store" },
      });
    }
  },
} satisfies ExportedHandler<Env>;
