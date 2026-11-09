import { env } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { createSchema } from "../src/domain/contracts";
import { BankRepository } from "../src/repositories/bank";
import { loadContext } from "../src/services/brief";
import { ResearchOrchestrator } from "../src/services/research";
afterEach(() => vi.restoreAllMocks());
const bank = () => new BankRepository(env, "owner_test");
function research(publishedAt?: string) {
  vi.spyOn(ResearchOrchestrator.prototype, "research").mockResolvedValue({
    status: "partial",
    evidence: [
      {
        id: "source",
        kind: "web",
        provider: "tavily",
        url: "https://example.com/news",
        excerpt: "A reported event",
        retrievedAt: new Date().toISOString(),
        ...(publishedAt ? { publishedAt } : {}),
        claims: [],
        verification: "single_source",
      },
    ],
    angles: [],
    warnings: [],
    providers_used: ["tavily"],
  });
}
it("accepts recent dated sources for explicit current-information requests", async () => {
  research(new Date(Date.now() - 3600000).toISOString());
  await expect(
    loadContext(
      env,
      bank(),
      createSchema.parse({
        topic: "A specific announcement",
        current_information_required: "yes",
      }),
    ),
  ).resolves.toMatchObject({ research: { status: "partial" } });
});
it.each([
  undefined,
  new Date(Date.now() - 8 * 86400000).toISOString(),
  new Date(Date.now() + 86400000).toISOString(),
])(
  "rejects missing, stale and future dates without substituting retrieval time: %s",
  async (date) => {
    research(date);
    await expect(
      loadContext(
        env,
        bank(),
        createSchema.parse({
          topic: "A specific announcement",
          current_information_required: "yes",
        }),
      ),
    ).rejects.toMatchObject({
      code: "RESEARCH_UNAVAILABLE",
      details: {
        required_window_days: 7,
        web_source_count: 1,
        dated_web_source_count: date ? 1 : 0,
      },
    });
  },
);
it("allows timeless topics without dated sources", async () => {
  research();
  await expect(
    loadContext(
      env,
      bank(),
      createSchema.parse({
        topic: "Writing clear documentation",
        current_information_required: "no",
      }),
    ),
  ).resolves.toMatchObject({ research: { status: "evergreen_only" } });
});

it("keeps optional research failures from blocking timeless writing", async () => {
  vi.spyOn(ResearchOrchestrator.prototype, "research").mockResolvedValue({
    status: "unavailable",
    evidence: [],
    angles: [],
    warnings: ["tavily research unavailable"],
    providers_used: [],
  });
  const result = await loadContext(
    env,
    bank(),
    createSchema.parse({
      topic: "My thoughts on today's tools",
      research_mode: "optional",
    }),
  );
  expect(result.research.status).toBe("evergreen_only");
  expect(result.research.warnings).toContain("tavily research unavailable");
});
