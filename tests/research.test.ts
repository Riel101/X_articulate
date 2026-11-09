import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ResearchOrchestrator } from "../src/services/research";
import type { ResearchProvider } from "../src/providers/research";
describe("research fallbacks", () => {
  const failed: ResearchProvider = {
    id: "failed",
    supports: () => true,
    search: async () => {
      throw new Error("unavailable");
    },
  };
  it("fails closed for current topics and permits timeless fallback", async () => {
    expect(
      (
        await new ResearchOrchestrator(env, [failed]).research(
          "breaking news today",
        )
      ).status,
    ).toBe("unavailable");
    expect(
      (
        await new ResearchOrchestrator(env, [failed]).research(
          "writing clear code",
        )
      ).status,
    ).toBe("evergreen_only");
  });
  it("preserves useful sources when one provider fails without claiming verification", async () => {
    const good: ResearchProvider = {
      id: "good",
      supports: () => true,
      search: async () => [
        {
          id: "one",
          kind: "web",
          provider: "good",
          url: "https://example.com/",
          excerpt: "A source",
          retrievedAt: new Date().toISOString(),
          claims: [],
          verification: "single_source",
        },
      ],
    };
    const result = await new ResearchOrchestrator(env, [failed, good]).research(
      "unique-test-topic",
    );
    expect(result.status).toBe("partial");
    expect(result.evidence).toHaveLength(1);
    expect(result.warnings).toContain("failed research unavailable");
  });
});
