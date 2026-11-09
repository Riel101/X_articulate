import type { Env } from "../config/env";
import { AppError } from "../domain/errors";
// Browser origins are deployment policy, never an agent identity check.
export function allowedOrigins(request: Request, env: Env): string[] {
  const origins = [new URL(env.MCP_PUBLIC_URL ?? request.url).origin];
  for (const entry of (env.MCP_ALLOWED_ORIGINS ?? "").split(",")) {
    const value = entry.trim();
    if (!value) continue;
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new AppError(
        "INTERNAL_ERROR",
        "MCP_ALLOWED_ORIGINS must contain comma-separated full HTTP(S) origins.",
      );
    }
    if (
      parsed.origin !== value ||
      !["https:", "http:"].includes(parsed.protocol)
    )
      throw new AppError(
        "INTERNAL_ERROR",
        "MCP_ALLOWED_ORIGINS entries must be exact HTTP(S) origins without paths.",
      );
    origins.push(value);
  }
  return [...new Set(origins)];
}
export function checkOrigin(request: Request, env: Env) {
  const origin = request.headers.get("Origin");
  if (origin && !allowedOrigins(request, env).includes(origin))
    throw new AppError(
      "FORBIDDEN",
      "This browser origin is not enabled. Add its exact origin to MCP_ALLOWED_ORIGINS.",
    );
}
export function corsResponse(response: Response, request: Request, env: Env) {
  const origin = request.headers.get("Origin");
  if (!origin || !allowedOrigins(request, env).includes(origin))
    return response;
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set(
    "Access-Control-Expose-Headers",
    "WWW-Authenticate, Mcp-Session-Id, MCP-Protocol-Version",
  );
  headers.append("Vary", "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
export function preflight(request: Request, env: Env) {
  checkOrigin(request, env);
  return corsResponse(
    new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers":
          "Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID",
        "Access-Control-Max-Age": "600",
      },
    }),
    request,
    env,
  );
}
