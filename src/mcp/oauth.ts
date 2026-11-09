import {
  OAuthProvider,
  AuthorizationError,
  CimdFetchError,
  type OAuthHelpers,
  type ConsentDescription,
  type OAuthResourceContext,
} from "@cloudflare/workers-oauth-provider";
import { z } from "zod";
import type { Env, Identity } from "../config/env";
import { AppError, hash } from "../domain/errors";

const TOOL_SCOPES = ["research", "generate", "metrics"];
const propsSchema = z.object({
  ownerId: z.string(),
  scopes: z.array(z.string()),
});
export function enabledScopes(env: Env) {
  return TOOL_SCOPES.filter((s) =>
    (env.MCP_SCOPES ?? TOOL_SCOPES.join(" ")).split(/\s+/).includes(s),
  );
}
export function publicResource(request: Request, env: Env) {
  const url = new URL(env.MCP_PUBLIC_URL ?? "/mcp", request.url);
  if (
    url.pathname !== "/mcp" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(url.hostname)
      ))
  )
    throw new AppError(
      "INTERNAL_ERROR",
      "MCP_PUBLIC_URL must be your HTTPS Worker URL ending in /mcp.",
    );
  return url;
}
export function oauthIdentity(
  env: Env,
  ctx: OAuthResourceContext<unknown>,
): Identity {
  const props = propsSchema.safeParse(ctx.props);
  if (!props.success || props.data.ownerId !== env.MCP_OWNER_ID)
    throw new AppError(
      "UNAUTHORIZED",
      "OAuth grant no longer belongs to the configured owner.",
    );
  const allowed = enabledScopes(env);
  return {
    ownerId: props.data.ownerId,
    scopes: new Set(
      props.data.scopes.filter(
        (s) => allowed.includes(s) && ctx.auth.scope.includes(s),
      ),
    ),
  };
}
const escape = (v: string) =>
  v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
function consentPage(details: ConsentDescription, handle: string) {
  const descriptions: Record<string, string> = {
    research: "Research topics using web and X sources",
    generate: "Create and evaluate posts using your API credits",
    metrics: "Link owned posts and read and update your performance bank",
    offline_access: "Keep this connection available with refresh tokens",
  };
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect X Content Intelligence</title>
  <body><main><h1>Connect X Content Intelligence</h1><p><strong>${escape(details.clientName)}</strong> wants access to your account.</p>
  <p>${details.clientDomain ? `Client publisher: <strong>${escape(details.clientDomain)}</strong>.` : "This client registered itself; its name is not verified."} Access returns to <strong>${escape(details.redirectHost)}</strong>.</p>
  ${details.redirectIsLoopback ? "<p>This connects an app on your computer. Continue only if you started this connection.</p>" : ""}
  <form method="post" action="/authorize"><input type="hidden" name="handle" value="${escape(handle)}">
  <fieldset><legend>Requested permissions</legend>${details.scope.map((s) => `<p><label><input type="checkbox" name="scope" value="${escape(s)}" checked> ${escape(descriptions[s] ?? s)}</label></p>`).join("")}</fieldset>
  <p><label>Owner access key<br><input type="password" name="owner_key" autocomplete="off" required minlength="32" maxlength="1024"></label></p>
  <p>Enter your server's private owner access key to approve. It is checked here and is never shared with the client.</p>
  <button name="decision" value="approve">Allow connection</button> <button name="decision" value="deny" formnovalidate>Deny</button></form></main></body></html>`;
}
async function reserveLoginAttempt(request: Request, env: Env) {
  const now = Math.floor(Date.now() / 1000);
  const window = Math.floor(now / 900);
  const ip = request.headers.get("CF-Connecting-IP") ?? "local";
  const key = await hash(`${env.MCP_OWNER_ID}:${ip}:${window}`);
  await env.DB.prepare("DELETE FROM oauth_login_attempts WHERE expires_at<?")
    .bind(now)
    .run();
  const reserved = await env.DB.prepare(
    "INSERT INTO oauth_login_attempts(bucket_key,attempts,expires_at) VALUES(?,1,?) ON CONFLICT(bucket_key) DO UPDATE SET attempts=attempts+1 WHERE attempts<10",
  )
    .bind(key, (window + 1) * 900)
    .run();
  if (!reserved.meta.changes)
    throw new AppError(
      "RATE_LIMITED",
      "Too many sign-in attempts. Try again in 15 minutes.",
      true,
    );
}
async function authorize(
  request: Request,
  env: Env & { OAUTH_PROVIDER: OAuthHelpers },
) {
  if (
    !env.MCP_AUTH_TOKEN ||
    env.MCP_AUTH_TOKEN.length < 32 ||
    !env.MCP_OWNER_ID
  )
    return new Response(
      "Configure MCP_AUTH_TOKEN (32+ characters) and MCP_OWNER_ID on the Worker before connecting.",
      { status: 503 },
    );
  const oauth = env.OAUTH_PROVIDER;
  try {
    if (request.method === "GET") {
      const auth = await oauth.parseAuthRequest(request);
      if (auth.codeChallengeMethod !== "S256" || !auth.codeChallenge)
        return new Response("S256 PKCE is required.", { status: 400 });
      const details = await oauth.describeConsent(auth);
      const consent = await oauth.beginConsent(auth);
      consent.headers.set("Content-Type", "text/html; charset=utf-8");
      // no-referrer can turn a browser form POST Origin into null.
      // same-origin preserves CSRF origin checks without leaking the approval URL to the callback.
      consent.headers.set("Referrer-Policy", "same-origin");
      consent.headers.set(
        "Content-Security-Policy",
        `default-src 'none'; form-action 'self' ${new URL(auth.redirectUri).origin}; frame-ancestors 'none'; base-uri 'none'`,
      );
      return new Response(consentPage(details, consent.handle), {
        headers: consent.headers,
      });
    }
    if (request.method !== "POST")
      return new Response("Method not allowed", {
        status: 405,
        headers: { Allow: "GET, POST" },
      });
    if (request.headers.get("Origin") !== new URL(request.url).origin)
      return new Response("Invalid approval origin.", { status: 403 });
    if (
      !request.headers
        .get("Content-Type")
        ?.startsWith("application/x-www-form-urlencoded")
    )
      return new Response("Expected a consent form.", { status: 415 });
    // Bound bytes before parsing so anonymous requests cannot consume unbounded memory.
    const reader = request.body?.getReader();
    let size = 0;
    let body = "";
    const decoder = new TextDecoder();
    if (reader)
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 8192) {
          await reader.cancel();
          return new Response("Form too large.", { status: 413 });
        }
        body += decoder.decode(value, { stream: true });
      }
    body += decoder.decode();
    const form = new URLSearchParams(body);
    const handle = form.get("handle") ?? "";
    if (form.get("decision") === "deny") {
      const denied = await oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    if (form.get("decision") !== "approve")
      return new Response("Choose Allow or Deny.", { status: 400 });
    await reserveLoginAttempt(request, env);
    const key = form.get("owner_key") ?? "";
    if (!key || (await hash(key)) !== (await hash(env.MCP_AUTH_TOKEN)))
      return new Response(
        "Incorrect owner access key. Go back and try again.",
        { status: 401, headers: { "Cache-Control": "no-store" } },
      );
    const scopes = form.getAll("scope");
    const allowed = [...enabledScopes(env), "offline_access"];
    if (scopes.some((s) => !allowed.includes(s)))
      return new Response("Unsupported permission requested.", { status: 400 });
    const approved = await oauth.approveConsent(request, handle, {
      scope: scopes,
    });
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: env.MCP_OWNER_ID,
      metadata: {},
      scope: approved.request.scope,
      props: {
        ownerId: env.MCP_OWNER_ID,
        scopes: approved.request.scope.filter((s) => TOOL_SCOPES.includes(s)),
      },
    });
    approved.headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (error) {
    if (error instanceof AuthorizationError) {
      if (request.method === "GET" && error.redirectTo)
        return Response.redirect(error.redirectTo, 302);
      return new Response(error.description, {
        status: 400,
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (error instanceof CimdFetchError)
      return new Response(
        "Could not verify this client. Start the connection again.",
        { status: 400 },
      );
    if (error instanceof AppError && error.code === "RATE_LIMITED")
      return new Response(error.message, {
        status: 429,
        headers: { "Retry-After": "900" },
      });
    throw error;
  }
}
export function createOAuthProvider(
  request: Request,
  env: Env,
  handler: (
    request: Request,
    env: Env,
    ctx: OAuthResourceContext<unknown>,
  ) => Promise<Response>,
) {
  const resource = publicResource(request, env);
  return new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler: {
      fetch: (req, bindings, ctx) =>
        handler(req, bindings, ctx as OAuthResourceContext<unknown>),
    },
    defaultHandler: {
      fetch: (req, bindings) =>
        new URL(req.url).pathname === "/authorize"
          ? authorize(req, bindings as Env & { OAUTH_PROVIDER: OAuthHelpers })
          : Promise.resolve(new Response("Not found", { status: 404 })),
    },
    authorizeEndpoint: `${resource.origin}/authorize`,
    tokenEndpoint: `${resource.origin}/oauth/token`,
    clientRegistrationEndpoint: `${resource.origin}/oauth/register`,
    resourceMetadata: {
      resource: resource.href,
      authorization_servers: [resource.origin],
      resource_name: "X Content Intelligence",
    },
    scopesSupported: [...enabledScopes(env), "offline_access"],
    requiredScopes: enabledScopes(env),
    accessTokenTTL: 3600,
    refreshTokenTTL: 2592000,
    clientIdMetadataDocumentEnabled: true,
  });
}
