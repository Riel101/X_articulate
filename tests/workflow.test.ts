import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSchema } from "../src/domain/contracts";
import { BankRepository } from "../src/repositories/bank";
import { CreatePostWorkflow } from "../src/services/create-post";
import { PerformanceService } from "../src/services/performance";
import type { Env } from "../src/config/env";
const texts = [
  "Clear tools make reliable agents. Start with permissions, retries and logs.",
  "Before adding another agent, make one tool call easy to debug.",
  "An agent needs more than a prompt. Give each tool a clear contract.",
  "What happens when your agent tool fails? Design that path first.",
];
const dimensions = {
  relevance: 18,
  hook: 17,
  clarity: 13,
  value: 17,
  shareability: 11,
  discussion: 6,
};
let verificationText = texts[0];
let verified = true;
let metricsLikes = 10;
let metricsStatus = 200;
let modelCalls = 0;
let repairRequired = false;
let evaluations = 0;
async function generate() {
  const isolated: Env = {
    ...env,
    TAVILY_API_KEY: undefined,
    ZERNIO_API_KEY: undefined,
  };
  const bank = new BankRepository(isolated, "owner_test");
  const result = await new CreatePostWorkflow(isolated, bank).run(
    createSchema.parse({
      topic: "Agent reliability",
      idempotency_key: "first",
    }),
    "req_first",
  );
  return {
    bank: new BankRepository(env, "owner_test"),
    draftId: String(result.draft_id),
    result,
  };
}
function mockVerify(text = texts[0]) {
  verificationText = text;
}
function mockMetrics(likes = 10, status = 200) {
  metricsLikes = likes;
  metricsStatus = status;
}
beforeEach(() => {
  verificationText = texts[0];
  verified = true;
  metricsLikes = 10;
  metricsStatus = 200;
  modelCalls = 0;
  repairRequired = false;
  evaluations = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === "https://api.openai.com/v1/responses") {
      modelCalls++;
      const body = JSON.parse(String(init?.body));
      const supplied = JSON.parse(body.input);
      if (body.text.format.name === "evaluation") evaluations++;
      const value =
        body.text.format.name === "candidates"
          ? { candidates: texts.map((text, i) => ({ id: `c${i}`, text })) }
          : body.text.format.name === "revision"
            ? {
                id: "revised",
                text: "Reliable agents need clear tool contracts and visible failure paths.",
              }
            : {
                assessments: supplied.candidates.map((c: { id: string }) => ({
                  id: c.id,
                  dimensions,
                  factuality: !repairRequired || evaluations > 1,
                  safety: true,
                  originality: true,
                  issues: [],
                  strengths: ["clear"],
                })),
              };
      return Response.json({
        status: "completed",
        output: [
          { content: [{ type: "output_text", text: JSON.stringify(value) }] },
        ],
      });
    }
    if (url === "https://zernio.com/api/v1/posts/sync-external")
      return Response.json({
        found: verified,
        post: verified
          ? {
              platform: "twitter",
              platformPostId: "123456789",
              content: verificationText,
              publishedAt: new Date(Date.now() - 48 * 3600000).toISOString(),
            }
          : null,
      });
    if (url.startsWith("https://zernio.com/api/v1/analytics?"))
      return metricsStatus === 200
        ? Response.json({
            platformAnalytics: [
              {
                platform: "twitter",
                platformPostId: "123456789",
                accountId: "z-account",
                syncStatus: "synced",
                analytics: {
                  impressions: 100,
                  likes: metricsLikes,
                  comments: 2,
                  shares: 3,
                  quotes: 1,
                  lastUpdated: "2026-11-08T12:00:00Z",
                },
              },
            ],
          })
        : new Response(null, { status: metricsStatus });
    throw new Error(`Unexpected outgoing request: ${url}`);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});
describe("stored content lifecycle", () => {
  it("generates with an empty bank, persists evidence and replays without model calls", async () => {
    const { bank, draftId, result } = await generate();
    expect(result.ready_to_copy).toBe(true);
    expect(result.post_text).toBe(texts[0]);
    expect((await bank.draft(draftId))?.final_text).toBe(texts[0]);
    expect(
      await bank.insights("Agent reliability", "general readers"),
    ).toMatchObject({ sample_size: 0, learning_status: "insufficient_data" });
    const isolated: Env = {
      ...env,
      TAVILY_API_KEY: undefined,
      ZERNIO_API_KEY: undefined,
    };
    const replay = await new CreatePostWorkflow(isolated, bank).run(
      createSchema.parse({
        topic: "Agent reliability",
        idempotency_key: "first",
      }),
      "req_second",
    );
    expect(replay.draft_id).toBe(draftId);
    expect(modelCalls).toBe(2);
    await expect(
      new CreatePostWorkflow(isolated, bank).run(
        createSchema.parse({ topic: "Different", idempotency_key: "first" }),
        "req_third",
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
  it("repairs a failed factuality gate and persists only a fresh evaluation of the final text", async () => {
    repairRequired = true;
    const { result, draftId } = await generate();
    expect(result.post_text).toBe(
      "Reliable agents need clear tool contracts and visible failure paths.",
    );
    expect(modelCalls).toBe(4);
    const assessment = await env.DB.prepare(
      "SELECT candidate_id FROM evaluations WHERE draft_id=?",
    )
      .bind(draftId)
      .all<{ candidate_id: string }>();
    expect(assessment.results.map((r) => r.candidate_id)).toEqual(["revised"]);
  });
  it("links actual edited text, stores metrics once, and appends changed observations", async () => {
    const { bank, draftId } = await generate();
    const service = new PerformanceService(env, bank);
    mockVerify("An edited post with a different question?");

    const linked = await service.register({
      draft_id: draftId,
      x_post_url_or_id: "123456789",
    });
    expect(linked.edited_from_draft).toBe(true);
    expect(
      (await bank.publication(linked.published_post_id))?.actual_text,
    ).toBe("An edited post with a different question?");
    mockMetrics();
    const first = await service.get(linked.published_post_id, true);
    expect(first.reference_bank).toMatchObject({
      updated: true,
      new_snapshot: true,
      learning_summary_refreshed: true,
    });
    mockMetrics();
    const second = await service.get(linked.published_post_id, true);
    expect(second.reference_bank.new_snapshot).toBe(false);
    expect(second.observed_at).toBe(first.observed_at);
    mockMetrics(15);
    expect(
      (await service.get(linked.published_post_id, true)).reference_bank
        .new_snapshot,
    ).toBe(true);
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM metric_snapshots",
    ).first<{ n: number }>();
    expect(count?.n).toBe(2);
    expect(
      (await bank.insights("Agent reliability", "general readers")).sample_size,
    ).toBe(1);
    const other = new BankRepository(env, "another_owner");
    expect(await other.draft(draftId)).toBeNull();
    expect(await other.publication(linked.published_post_id)).toBeNull();
    expect(
      (await other.insights("Agent reliability", "general readers"))
        .sample_size,
    ).toBe(0);
  });
  it("does not persist pending or unavailable observations", async () => {
    const { bank, draftId } = await generate();
    const service = new PerformanceService(env, bank);
    mockVerify();
    const linked = await service.register({
      draft_id: draftId,
      x_post_url_or_id: "123456789",
    });
    mockMetrics(0, 202);
    expect((await service.get(linked.published_post_id, true)).status).toBe(
      "pending",
    );
    mockMetrics(0, 424);
    expect((await service.get(linked.published_post_id, true)).status).toBe(
      "unavailable",
    );
    expect(
      (
        await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM metric_snapshots",
        ).first<{ n: number }>()
      )?.n,
    ).toBe(0);
  });
  it("rejects post verification for a different account/post", async () => {
    const { bank, draftId } = await generate();
    verified = false;
    await expect(
      new PerformanceService(env, bank).register({
        draft_id: draftId,
        x_post_url_or_id: "123456789",
      }),
    ).rejects.toMatchObject({ code: "POST_NOT_LINKED" });
  });
  it("authenticates before protocol handling and provider requests", async () => {
    expect(
      (
        await SELF.fetch("https://example.com/mcp", {
          method: "POST",
          body: "{}",
          headers: { "Content-Type": "application/json" },
        })
      ).status,
    ).toBe(401);
    expect((await SELF.fetch("https://example.com/health")).status).toBe(200);
  });
});
