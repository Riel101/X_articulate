import { createMcpHandler } from "agents/mcp/server";
import type { Env } from "./config/env";
import { AppError, errorResult, id } from "./domain/errors";
import { authenticate } from "./mcp/auth";
import { createServer } from "./mcp/server";
export default {
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
        version: "1.0.0",
      });
    if (path !== "/mcp") return new Response("Not found", { status: 404 });
    try {
      const identity = await authenticate(request, env);
      // Same-origin browser access; private clients should send bearer headers directly.
      const origin = request.headers.get("Origin");
      if (origin && origin !== new URL(request.url).origin)
        throw new AppError(
          "FORBIDDEN",
          "Cross-origin browser requests are not enabled.",
        );
      if (request.method === "POST") {
        if (!request.headers.get("Content-Type")?.includes("application/json"))
          return new Response("Expected application/json", { status: 415 });
        const size = Number(request.headers.get("Content-Length") ?? "0");
        if (size > 65536)
          return new Response("Request too large", { status: 413 });
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
      })(request, env, ctx);
    } catch (error) {
      return Response.json(errorResult(error, id("req")), {
        status:
          error instanceof AppError && error.code === "FORBIDDEN"
            ? 403
            : error instanceof AppError && error.code === "UNAUTHORIZED"
              ? 401
              : 500,
        headers: {
          "Cache-Control": "no-store",
          ...(error instanceof AppError && error.code === "UNAUTHORIZED"
            ? { "WWW-Authenticate": 'Bearer realm="x-content-intelligence"' }
            : {}),
        },
      });
    }
  },
} satisfies ExportedHandler<Env>;
