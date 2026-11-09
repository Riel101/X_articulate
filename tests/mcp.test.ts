import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
const headers = {
  Host: "localhost",
  Authorization: `Bearer ${env.MCP_AUTH_TOKEN}`,
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};
async function rpc(body: unknown) {
  const response = await SELF.fetch("http://localhost/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const data =
    text.startsWith("event:") || text.startsWith("data:")
      ? JSON.parse(
          text
            .split("\n")
            .find((l) => l.startsWith("data:"))!
            .slice(5),
        )
      : JSON.parse(text);
  return { response, data };
}
describe("remote MCP contract", () => {
  it.each(["2024-11-05", "2025-03-26", "2025-11-25"])(
    "initializes an MCP client using protocol %s",
    async (protocolVersion) => {
      const { response, data } = await rpc({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion,
          capabilities: {},
          clientInfo: { name: "acceptance-client", version: "1.0" },
        },
      });
      expect(response.status, JSON.stringify(data)).toBe(200);
      expect(data.result.serverInfo.name).toBe("x-content-intelligence");
    },
  );
  it("discovers the same seven typed tools from a fresh request", async () => {
    const { response, data } = await rpc({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    expect(response.status, JSON.stringify(data)).toBe(200);
    expect(
      data.result.tools.map((t: { name: string }) => t.name).sort(),
    ).toEqual(
      [
        "create_post",
        "research_topic",
        "search_reference_bank",
        "evaluate_post",
        "register_published_post",
        "get_post_performance",
        "get_learning_report",
      ].sort(),
    );
    expect(
      data.result.tools.every(
        (t: { inputSchema: unknown; outputSchema: unknown }) =>
          t.inputSchema && t.outputSchema,
      ),
    ).toBe(true);
  });
  it("calls a read tool with durable D1", async () => {
    const { data } = await rpc({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "get_learning_report", arguments: {} },
    });
    expect(data.result.isError).not.toBe(true);
    expect(data.result.structuredContent.total_published_posts).toBe(0);
  });
});

it("publishes tool contracts before OAuth while keeping anonymous execution protected", async () => {
  const publicHeaders = {
    Host: "localhost",
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  const list = await SELF.fetch("https://localhost/mcp", {
    method: "POST",
    headers: publicHeaders,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    }),
  });
  expect(list.status).toBe(200);
  const text = await list.text();
  const data = JSON.parse(
    text.startsWith("event:") || text.startsWith("data:")
      ? text
          .split("\n")
          .find((l) => l.startsWith("data:"))!
          .slice(5)
      : text,
  );
  expect(data.result.tools).toHaveLength(7);
  expect(
    data.result.tools.find((t: { name: string }) => t.name === "create_post")
      ._meta.securitySchemes,
  ).toEqual([{ type: "oauth2", scopes: ["generate"] }]);
  const call = await SELF.fetch("https://localhost/mcp", {
    method: "POST",
    headers: publicHeaders,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "get_learning_report", arguments: {} },
    }),
  });
  expect(call.status).toBe(401);
  expect(call.headers.get("WWW-Authenticate")).toContain("resource_metadata=");
  expect(
    (
      await env.DB.prepare("SELECT COUNT(*) AS n FROM usage_events").first<{
        n: number;
      }>()
    )?.n,
  ).toBe(0);
});
