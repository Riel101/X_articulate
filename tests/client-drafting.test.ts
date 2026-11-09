import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Env } from "../src/config/env";
import {
  createSchema,
  finalizeSchema,
  evaluateSchema,
} from "../src/domain/contracts";
import { BankRepository } from "../src/repositories/bank";
import { ClientDraftingService } from "../src/services/client-drafting";
import { validateClientCandidates } from "../src/services/client-evaluation";
import { CreatePostWorkflow } from "../src/services/create-post";
import { PerformanceService } from "../src/services/performance";
import worker from "../src/index";
const bindings: Env = {
  ...env,
  GENERATION_MODE: "client",
  OPENAI_API_KEY: undefined,
  OPENAI_MODEL: undefined,
  TAVILY_API_KEY: undefined,
  ZERNIO_API_KEY: undefined,
};
const bank = () => new BankRepository(bindings, "owner_test");
const assessment = {
  summary: "Clear and useful advice for builders.",
  improvements: [],
  dimension_scores: {
    relevance: 18,
    hook: 16,
    clarity: 14,
    value: 18,
    shareability: 12,
    discussion: 7,
  },
  strengths: ["Clear takeaway"],
  caveats: [],
  factuality_reviewed: true,
  originality_reviewed: true,
  safety_reviewed: true,
};
const text =
  "Reliable agents need observable tools. Start with clear contracts, logs, and a recovery path.";
async function prepare(key = "client-key") {
  return new CreatePostWorkflow(bindings, bank()).run(
    createSchema.parse({
      topic: "Agent reliability",
      must_include: ["tools"],
      avoid: ["guaranteed"],
      idempotency_key: key,
    }),
    "req_client",
  );
}
function final(briefId: string, post = text) {
  return finalizeSchema.parse({
    brief_id: briefId,
    post_text: post,
    assessment,
    client_model: "test-host",
  });
}
beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("Unexpected provider call"),
  );
});
afterEach(() => vi.restoreAllMocks());
it("uses the client model by default even if an OpenAI key is configured", async () => {
  const defaultMode = {
    ...bindings,
    GENERATION_MODE: undefined,
    OPENAI_API_KEY: "unused-key",
  };
  const result = await new CreatePostWorkflow(
    defaultMode,
    new BankRepository(defaultMode, "owner_test"),
  ).run(createSchema.parse({ topic: "Agent reliability" }), "req_default");
  expect(result).toMatchObject({
    status: "client_drafting_required",
    ready_to_copy: false,
    requires_server_model_key: false,
  });
  expect(globalThis.fetch).not.toHaveBeenCalled();
});
it("prepares, finalizes and replays a client post with transparent assessment provenance and no provider calls", async () => {
  const brief = await prepare();
  expect(brief.status).toBe("client_drafting_required");
  expect((await prepare()).brief_id).toBe(brief.brief_id);
  const service = new ClientDraftingService(bindings, bank());
  const input = final(String(brief.brief_id));
  const saved = await service.finalize(input);
  expect(saved).toMatchObject({
    status: "complete",
    post_text: text,
    ready_to_copy: true,
    generation_mode: "client",
    pre_publication_analytics: {
      type: "editorial_review",
      assessment_source: "client",
      quality_score: null,
    },
    validation: { length: "pass", factuality: "client_reviewed" },
  });
  expect((await service.finalize(input)).draft_id).toBe(saved.draft_id);
  expect((await prepare()).draft_id).toBe(saved.draft_id);
  const stored = await bank().draft(String(saved.draft_id));
  expect(stored?.final_text).toBe(text);
  const evaluation = await env.DB.prepare(
    "SELECT client_model FROM editorial_reviews WHERE draft_id=?",
  )
    .bind(saved.draft_id)
    .first();
  expect(evaluation?.client_model).toBe("test-host");
  expect(globalThis.fetch).not.toHaveBeenCalled();
});
it("rejects changed idempotent inputs, invalid text, unreviewed claims, foreign briefs and fabricated source references", async () => {
  const brief = await prepare();
  const service = new ClientDraftingService(bindings, bank());
  const input = final(String(brief.brief_id));
  await expect(
    new CreatePostWorkflow(bindings, bank()).run(
      createSchema.parse({ topic: "Different", idempotency_key: "client-key" }),
      "req_changed",
    ),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  for (const post of ["   ", "No required phrase.", "tools are guaranteed"])
    await expect(
      service.finalize(final(String(brief.brief_id), post)),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  await expect(
    service.finalize({
      ...input,
      assessment: { ...assessment, factuality_reviewed: false },
    }),
  ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  await expect(
    service.finalize({
      ...input,
      claims: [{ claim: "A statistic", source_ids: ["invented"] }],
    }),
  ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  await expect(
    new ClientDraftingService(
      bindings,
      new BankRepository(bindings, "another_owner"),
    ).finalize(input),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  await service.finalize(input);
  await expect(
    service.finalize({ ...input, post_text: text + " More tools." }),
  ).rejects.toMatchObject({ code: "INVALID_INPUT" });
});
it("rejects expired research briefs without saving a draft", async () => {
  const brief = await prepare();
  await env.DB.prepare("UPDATE drafting_briefs SET expires_at=? WHERE id=?")
    .bind("2000-01-01T00:00:00Z", brief.brief_id)
    .run();
  await expect(
    new ClientDraftingService(bindings, bank()).finalize(
      final(String(brief.brief_id)),
    ),
  ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  expect(
    (
      await env.DB.prepare("SELECT COUNT(*) AS n FROM drafts").first<{
        n: number;
      }>()
    )?.n,
  ).toBe(0);
});
it("offers deterministic evaluation over MCP and finalizes without any model key", async () => {
  async function call(name: string, args: unknown) {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://localhost/mcp", {
        method: "POST",
        headers: {
          Host: "localhost",
          Authorization: `Bearer ${env.MCP_AUTH_TOKEN}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      }),
      bindings,
      ctx,
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    const data = JSON.parse(
      body.startsWith("event:") || body.startsWith("data:")
        ? body
            .split("\n")
            .find((l) => l.startsWith("data:"))!
            .slice(5)
        : body,
    );
    await waitOnExecutionContext(ctx);
    expect(data.result.isError, JSON.stringify(data.result)).not.toBe(true);
    return data.result.structuredContent;
  }
  const brief = await call("create_post", { topic: "Agent reliability" });
  const evaluation = await call("evaluate_post", {
    topic: "Agent reliability",
    candidates: [{ id: "one", text }],
  });
  expect(evaluation.type).toBe("deterministic_validation_only");
  expect(evaluation.ranked_candidates[0].quality_score).toBeNull();
  const saved = await call("finalize_post", final(brief.brief_id));
  expect(saved.pre_publication_analytics.assessment_source).toBe("client");
  expect(globalThis.fetch).not.toHaveBeenCalled();
});
it("links edited client-generated text without making a hidden model call", async () => {
  const brief = await prepare();
  const saved = await new ClientDraftingService(bindings, bank()).finalize(
    final(String(brief.brief_id)),
  );
  const actual = "An edited published post about tools.";
  const fetchSpy = vi.mocked(globalThis.fetch);
  fetchSpy.mockImplementation(async (input) => {
    expect(String(input)).toBe("https://zernio.com/api/v1/posts/sync-external");
    return Response.json({
      found: true,
      post: {
        platform: "twitter",
        platformPostId: "123456789",
        content: actual,
        publishedAt: new Date(Date.now() - 3600000).toISOString(),
      },
    });
  });
  const linked = await new PerformanceService(
    { ...bindings, ZERNIO_API_KEY: "test-key" },
    new BankRepository(
      { ...bindings, ZERNIO_API_KEY: "test-key" },
      "owner_test",
    ),
  ).register({
    draft_id: String(saved.draft_id),
    x_post_url_or_id: "123456789",
  });
  expect(linked.edited_from_draft).toBe(true);
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  expect(
    (await bank().publication(linked.published_post_id))?.actual_text,
  ).toBe(actual);
});

it("preserves web provenance while using only the research API, never a model API", async () => {
  const researchEnv = { ...bindings, TAVILY_API_KEY: "test-research-key" };
  vi.mocked(globalThis.fetch).mockImplementation(async (input) => {
    expect(String(input)).toBe("https://api.tavily.com/search");
    return Response.json({
      results: [
        {
          title: "Writing reliable documentation",
          url: "https://example.org/docs/client-provenance",
          content: "Clear documentation helps readers complete tasks.",
        },
      ],
    });
  });
  const ownBank = new BankRepository(researchEnv, "owner_test");
  const service = new ClientDraftingService(researchEnv, ownBank);
  const brief = await service.prepare(
    createSchema.parse({
      topic: "Client research provenance unique",
      research_mode: "optional",
    }),
    "req_sources",
  );
  const sourceId = (brief.research as { sources: { id: string }[] }).sources[0]
    .id;
  const saved = await service.finalize({
    ...final(String(brief.brief_id)),
    claims: [
      {
        claim: "Clear documentation helps readers complete tasks.",
        source_ids: [sourceId],
      },
    ],
  });
  const stored = await env.DB.prepare(
    "SELECT source_url,claim FROM research_sources WHERE draft_id=?",
  )
    .bind(saved.draft_id)
    .first<{ source_url: string; claim: string }>();
  expect(stored?.source_url).toBe("https://example.org/docs/client-provenance");
  expect(stored?.claim).toContain(
    "Clear documentation helps readers complete tasks.",
  );
  expect(globalThis.fetch).toHaveBeenCalledTimes(1);
});

it("finalizes and evaluates long text without a character cap", async () => {
  const brief = await prepare();
  const longText = "Useful tools help people work clearly. ".repeat(80);
  const saved = await new ClientDraftingService(bindings, bank()).finalize(
    finalizeSchema.parse(final(String(brief.brief_id), longText)),
  );
  expect(saved.post_text).toBe(longText);
  expect(
    (saved.pre_publication_analytics as { character_limit: null })
      .character_limit,
  ).toBeNull();
  const evaluated = await validateClientCandidates(
    evaluateSchema.parse({
      topic: "Tools",
      candidates: [{ id: "long", text: longText }],
    }),
  );
  expect(evaluated.ranked_candidates[0].deterministic_valid).toBe(true);
  expect((await bank().draft(String(saved.draft_id)))?.final_text).toBe(
    longText,
  );
});
