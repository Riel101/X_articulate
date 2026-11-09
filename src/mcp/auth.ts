import type { Env, Identity } from "../config/env";
import { AppError, hash } from "../domain/errors";
export async function authenticate(
  request: Request,
  env: Env,
): Promise<Identity> {
  if (
    !env.MCP_AUTH_TOKEN ||
    env.MCP_AUTH_TOKEN.length < 32 ||
    !env.MCP_OWNER_ID
  )
    throw new AppError(
      "UNAUTHORIZED",
      "Server authentication is not configured.",
    );
  const provided = request.headers
    .get("Authorization")
    ?.match(/^Bearer (\S+)$/)?.[1];
  if (!provided || (await hash(provided)) !== (await hash(env.MCP_AUTH_TOKEN)))
    throw new AppError("UNAUTHORIZED", "A valid bearer token is required.");
  return {
    ownerId: env.MCP_OWNER_ID,
    scopes: new Set(
      (env.MCP_SCOPES ?? "research generate metrics").split(/\s+/),
    ),
  };
}
export async function reserveUsage(
  env: Env,
  identity: Identity,
  tool: string,
  requestId: string,
) {
  const limit = Number(env.DAILY_TOOL_LIMIT ?? "100");
  if (!Number.isInteger(limit) || limit < 1)
    throw new AppError(
      "INTERNAL_ERROR",
      "DAILY_TOOL_LIMIT must be a positive integer.",
    );
  const result = await env.DB.prepare(
    "INSERT INTO usage_events(id,owner_id,request_id,tool_name,status,created_at) SELECT ?,?,?,?,'started',? WHERE (SELECT COUNT(*) FROM usage_events WHERE owner_id=? AND created_at>=?)<?",
  )
    .bind(
      `use_${crypto.randomUUID()}`,
      identity.ownerId,
      requestId,
      tool,
      new Date().toISOString(),
      identity.ownerId,
      new Date().toISOString().slice(0, 10),
      limit,
    )
    .run();
  if (!result.meta.changes)
    throw new AppError(
      "RATE_LIMITED",
      "Daily tool quota reached. Retry tomorrow or adjust the configured budget.",
      true,
    );
}
