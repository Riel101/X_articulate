import { env, SELF } from "cloudflare:test";
import { expect, it } from "vitest";
import worker from "../src/index";
import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
const body = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/list",
  params: {},
});
const base = {
  Host: "localhost",
  Authorization: `Bearer ${env.MCP_AUTH_TOKEN}`,
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};
it("allows a configured browser agent and answers its unauthenticated CORS preflight", async () => {
  const preflight = await SELF.fetch("https://localhost/mcp", {
    method: "OPTIONS",
    headers: {
      Origin: "https://agent.example",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization,content-type",
    },
  });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(
    "https://agent.example",
  );
  const response = await SELF.fetch("https://localhost/mcp", {
    method: "POST",
    headers: { ...base, Origin: "https://agent.example" },
    body,
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
    "https://agent.example",
  );
  expect(await response.text()).toContain("create_post");
});
it("rejects unconfigured browser origins, including vendor origins with no special exemption", async () => {
  for (const origin of ["https://evil.example", "https://chatgpt.com"]) {
    const response = await SELF.fetch("https://localhost/mcp", {
      method: "POST",
      headers: { ...base, Origin: origin },
      body,
    });
    expect(response.status).toBe(403);
    expect(response.headers.has("Access-Control-Allow-Origin")).toBe(false);
  }
});
it("supports native agents without an Origin header even with no browser origins configured", async () => {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request("https://localhost/mcp", {
      method: "POST",
      headers: base,
      body,
    }),
    { ...env, MCP_ALLOWED_ORIGINS: "" },
    ctx,
  );
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("create_post");
  await waitOnExecutionContext(ctx);
});
it("exposes OAuth challenges to configured browser agents without granting anonymous tool access", async () => {
  const response = await SELF.fetch("https://localhost/mcp", {
    headers: { Origin: "https://agent.example" },
  });
  expect(response.status).toBe(401);
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
    "https://agent.example",
  );
  expect(response.headers.get("WWW-Authenticate")).toContain(
    "resource_metadata=",
  );
});
