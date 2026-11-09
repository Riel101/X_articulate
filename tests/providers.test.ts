import { env } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { ZernioProvider } from "../src/providers/zernio";
import {
  TavilyProvider,
  ZernioResearchProvider,
} from "../src/providers/research";
afterEach(() => vi.restoreAllMocks());
it("normalizes Tavily evidence and keeps snippets unverified by independent sources", async () => {
  const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      results: [
        {
          title: "Official context",
          url: "https://example.com/docs",
          content: "A useful excerpt",
          published_date: "2026-11-08T00:00:00Z",
        },
        { url: "javascript:alert(1)", content: "bad" },
      ],
    }),
  );
  const result = await new TavilyProvider(env).search("agents", true);
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({
    provider: "tavily",
    verification: "single_source",
    url: "https://example.com/docs",
    publishedAt: "2026-11-08T00:00:00.000Z",
  });
  const body = JSON.parse(String(spy.mock.calls[0][1]?.body));
  expect(body).toMatchObject({
    include_answer: false,
    include_raw_content: false,
    max_results: 5,
    time_range: "week",
    topic: "news",
    days: 7,
  });
});
it("uses the connected account and documented query parameters for X research", async () => {
  const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      tweets: [
        {
          id: "123456789",
          text: "A discussion",
          author: { username: "writer" },
        },
      ],
    }),
  );
  const result = await new ZernioResearchProvider(env).search("agents");
  expect(result[0]).toMatchObject({
    url: "https://x.com/writer/status/123456789",
    verification: "unverified",
  });
  const url = new URL(String(spy.mock.calls[0][0]));
  expect(url.searchParams.get("accountId")).toBe("z-account");
  expect(url.searchParams.get("limit")).toBe("10");
});
it("rejects analytics for another account and never substitutes aggregate views for impressions", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      analytics: { impressions: 100000 },
      platformAnalytics: [
        {
          platform: "twitter",
          accountId: "someone-else",
          platformPostId: "123456789",
          analytics: { views: 9000 },
        },
      ],
    }),
  );
  expect(
    await new ZernioProvider(env).metrics("123456789", "123456789"),
  ).toEqual({ status: "unavailable" });
});
it("resolves an external analytics record after a native X ID miss", async () => {
  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.searchParams.has("postId"))
        return new Response(null, { status: 404 });
      expect(url.searchParams.get("accountId")).toBe("z-account");
      expect(url.searchParams.get("fromDate")).toBe("2026-11-08");
      return Response.json({
        posts: [
          {
            postId: "external-record",
            platformAnalytics: [
              {
                platform: "twitter",
                accountId: "z-account",
                platformPostId: "123456789",
                syncStatus: "synced",
                analytics: { likes: 0, comments: 1, views: 50 },
              },
            ],
          },
        ],
      });
    });
  const result = await new ZernioProvider(env).metrics(
    "123456789",
    "123456789",
    "2026-11-08T12:00:00Z",
  );
  expect(result.status).toBe("ok");
  if (result.status === "ok")
    expect(result.metrics).toMatchObject({
      likes: 0,
      replies: 1,
      impressions: null,
      views: 50,
    });
  expect(spy).toHaveBeenCalledTimes(2);
});
