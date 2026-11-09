import { env, SELF } from "cloudflare:test";
import { expect, it } from "vitest";
const origin = "https://localhost";
const resource = `${origin}/mcp`;
const verifier = "v".repeat(43);
async function fetchPath(path: string, init: RequestInit = {}) {
  return SELF.fetch(`${origin}${path}`, {
    ...init,
    headers: {
      Host: "localhost",
      ...Object.fromEntries(new Headers(init.headers)),
    },
    redirect: "manual",
  });
}
async function client() {
  const response = await fetchPath("/oauth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Generic MCP client",
      redirect_uris: ["https://agent.example/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return (await response.json()) as { client_id: string };
}
async function consent(clientId: string, challengeOverride?: string) {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  const challenge =
    challengeOverride ??
    btoa(String.fromCharCode(...digest))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: "https://agent.example/callback",
    resource,
    scope: "research generate metrics offline_access",
    state: "client-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const page = await fetchPath(`/authorize?${query}`);
  expect(page.status, await page.clone().text()).toBe(200);
  expect(page.headers.get("Content-Security-Policy")).toContain(
    "form-action 'self' https://agent.example",
  );
  expect(page.headers.get("Referrer-Policy")).toBe("same-origin");
  const html = await page.text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1];
  expect(handle).toBeTruthy();
  const cookie = page.headers.get("Set-Cookie")!.split(";")[0];
  return { handle: handle!, cookie, html };
}
async function approve(
  handle: string,
  cookie: string,
  key = env.MCP_AUTH_TOKEN,
  decision = "approve",
) {
  const form = new URLSearchParams({ handle, owner_key: key, decision });
  for (const scope of ["research", "generate", "metrics", "offline_access"])
    form.append("scope", scope);
  return fetchPath("/authorize", {
    method: "POST",
    headers: {
      Origin: origin,
      Cookie: cookie,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });
}
async function token(
  clientId: string,
  code: string,
  codeVerifier = verifier,
  audience = resource,
) {
  return fetchPath("/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: "https://agent.example/callback",
      code,
      code_verifier: codeVerifier,
      resource: audience,
    }).toString(),
  });
}
it("advertises protected-resource metadata, authorization endpoints, PKCE and refresh scopes", async () => {
  const challenge = await fetchPath("/mcp");
  expect(challenge.status).toBe(401);
  expect(challenge.headers.get("WWW-Authenticate")).toContain(
    "resource_metadata=",
  );
  const protectedMetadata = await fetchPath(
    "/.well-known/oauth-protected-resource/mcp",
  );
  expect(protectedMetadata.status).toBe(200);
  expect(await protectedMetadata.json()).toMatchObject({
    resource,
    authorization_servers: [origin],
  });
  const metadata = await fetchPath("/.well-known/oauth-authorization-server");
  expect(metadata.status).toBe(200);
  expect(await metadata.json()).toMatchObject({
    issuer: origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    code_challenge_methods_supported: ["S256"],
    scopes_supported: expect.arrayContaining([
      "research",
      "generate",
      "metrics",
      "offline_access",
    ]),
  });
});
it("completes owner approval, exchanges a code, discovers tools, refreshes and revokes", async () => {
  const app = await client();
  const page = await consent(app.client_id);
  expect(page.html).toContain("agent.example");
  expect(page.html).toContain("Owner access key");
  const approved = await approve(page.handle, page.cookie);
  expect(approved.status, await approved.clone().text()).toBe(302);
  const redirect = new URL(approved.headers.get("Location")!);
  expect(redirect.searchParams.get("state")).toBe("client-state");
  const exchanged = await token(
    app.client_id,
    redirect.searchParams.get("code")!,
  );
  expect(exchanged.status, await exchanged.clone().text()).toBe(200);
  const tokens = (await exchanged.json()) as {
    access_token: string;
    refresh_token: string;
  };
  expect(tokens.refresh_token).toBeTruthy();
  const tools = await fetchPath("/mcp", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    }),
  });
  expect(tools.status, await tools.clone().text()).toBe(200);
  const text = await tools.text();
  expect(text).toContain("create_post");
  expect(text).toContain("get_post_performance");
  const refresh = await fetchPath("/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: app.client_id,
      refresh_token: tokens.refresh_token,
      resource,
    }).toString(),
  });
  expect(refresh.status, await refresh.clone().text()).toBe(200);
  const refreshed = (await refresh.json()) as { refresh_token: string };
  const revoked = await fetchPath("/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: app.client_id,
      token: refreshed.refresh_token,
      token_type_hint: "refresh_token",
    }).toString(),
  });
  expect(revoked.status).toBe(200);
  const afterRevocation = await fetchPath("/mcp", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  expect(afterRevocation.status).toBe(401);

  expect(
    (await token(app.client_id, redirect.searchParams.get("code")!)).status,
  ).toBe(400);
  expect((await approve(page.handle, page.cookie)).status).toBe(400);
});
it("rejects wrong owner keys, a missing browser cookie, and foreign form origins", async () => {
  const app = await client();
  const page = await consent(app.client_id);
  expect(
    (
      await approve(
        page.handle,
        page.cookie,
        "incorrect-owner-key-that-is-long-enough",
      )
    ).status,
  ).toBe(401);
  expect((await approve(page.handle, "")).status).toBe(400);
  const foreign = await fetchPath("/authorize", {
    method: "POST",
    headers: {
      Origin: "https://evil.example",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      handle: page.handle,
      owner_key: env.MCP_AUTH_TOKEN,
      decision: "approve",
    }).toString(),
  });
  expect(foreign.status).toBe(403);
});
it("allows denial without entering an owner key", async () => {
  const app = await client();
  const page = await consent(app.client_id);
  const denied = await approve(page.handle, page.cookie, "", "deny");
  expect(denied.status).toBe(302);
  const location = new URL(denied.headers.get("Location")!);
  expect(location.searchParams.get("error")).toBe("access_denied");
  expect(location.searchParams.get("state")).toBe("client-state");
});
it("rejects a token exchange with a mismatched PKCE verifier", async () => {
  const app = await client();
  const page = await consent(app.client_id);
  const approved = await approve(page.handle, page.cookie);
  const code = new URL(approved.headers.get("Location")!).searchParams.get(
    "code",
  )!;
  expect((await token(app.client_id, code, "w".repeat(43))).status).toBe(400);
});
