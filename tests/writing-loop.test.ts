import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import worker from "../src/index";
import { ZernioProvider } from "../src/providers/zernio";
import { normalizeMetrics } from "../src/domain/post";
import { refreshPerformance } from "../src/services/performance-refresh";
import { VoiceService } from "../src/services/voice";
import { evaluateSchema } from "../src/domain/contracts";
import { rankingWeights } from "../src/services/ranking";
const bindings = {
  ...env,
  GENERATION_MODE: "client" as const,
  OPENAI_API_KEY: undefined,
  NVIDIA_API_KEY: undefined,
};
afterEach(() => vi.restoreAllMocks());
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
  const raw = await response.text();
  const result = JSON.parse(
    raw
      .split("\n")
      .find((l) => l.startsWith("data:"))
      ?.slice(5) ?? raw,
  ).result;
  await waitOnExecutionContext(ctx);
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  return result.structuredContent;
}
const review = {
  summary: "The concrete example supports the advice.",
  strengths: ["Useful and direct"],
  improvements: [
    {
      problem: "Generic opening",
      why: "The audience needs context",
      suggestion: "Lead with the problem you solved.",
    },
  ],
  factuality_reviewed: true,
  originality_reviewed: true,
  safety_reviewed: true,
};
it("completes voice → draft → editorial review → saved revision → publication → hourly metrics → informed next brief without a model API", async () => {
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("Unexpected network request"));
  await call("manage_voice", {
    action: "update_preferences",
    preferences: {
      style: ["direct", "concrete examples"],
      avoid: ["empty hype"],
    },
  });
  await call("manage_voice", {
    action: "add_example",
    text: "A useful tool solves a specific problem. Start there.",
    notes: "User approved this voice.",
  });
  const brief = await call("create_post", { topic: "Useful software tools" });
  expect(brief.voice.preferences.style).toContain("direct");
  expect(brief.voice.examples).toHaveLength(1);
  expect(brief.research.status).toBe("evergreen_only");
  const draft = await call("finalize_post", {
    brief_id: brief.brief_id,
    post_text:
      "Useful software starts with a specific problem. Ask what someone needs before adding another feature.",
    assessment: review,
  });
  expect(draft.pre_publication_analytics).toMatchObject({
    type: "editorial_review",
    quality_score: null,
  });
  const revision = await call("create_post", {
    topic: "Useful software tools",
    revision_of: draft.draft_id,
    feedback: "Use an example instead of generic advice.",
  });
  expect(revision.revision.text).toBe(draft.post_text);
  const edited = await call("finalize_post", {
    brief_id: revision.brief_id,
    post_text:
      "My notes app only needed one thing: finding yesterday’s decisions. Search helped more than another dashboard.",
    assessment: review,
  });
  const voice = await call("manage_voice", { action: "read" });
  expect(voice.observed_edits[0].feedback).toContain("Use an example");
  const verify = vi
    .spyOn(ZernioProvider.prototype, "verify")
    .mockResolvedValue({
      text: edited.post_text,
      publishedAt: new Date(Date.now() - 48 * 3600000).toISOString(),
      providerId: "external-123",
    });
  const linked = await call("register_published_post", {
    draft_id: edited.draft_id,
    x_post_url_or_id: "123456789",
  });
  expect(verify).toHaveBeenCalledTimes(1);
  const metrics = vi
    .spyOn(ZernioProvider.prototype, "metrics")
    .mockResolvedValue({
      status: "ok",
      updatedAt: new Date().toISOString(),
      metrics: normalizeMetrics({
        impressions: 1000,
        likes: 40,
        replies: 8,
        reposts: 5,
        quotes: 1,
      }),
    });
  const ctx = createExecutionContext();
  await worker.scheduled({} as ScheduledController, bindings, ctx);
  await waitOnExecutionContext(ctx);
  expect(metrics).toHaveBeenCalledTimes(1);
  expect(await refreshPerformance(bindings)).toMatchObject({ attempted: 0 });
  const next = await call("create_post", { topic: "Useful software tools" });
  expect(next.performance.recent_posts[0]).toMatchObject({
    post_id: linked.published_post_id,
    metrics: { impressions: 1000 },
    refresh_status: "ok",
  });
  expect(next.learning.status).toBe("insufficient_data");
  expect(next.voice.observed_edits).toHaveLength(1);
  metrics.mockResolvedValue({ status: "pending" });
  await env.DB.prepare(
    "UPDATE performance_refresh_state SET attempted_at=? WHERE published_post_id=?",
  )
    .bind(
      new Date(Date.now() - 2 * 3600000).toISOString(),
      linked.published_post_id,
    )
    .run();
  expect(await refreshPerformance(bindings)).toMatchObject({
    attempted: 1,
    updated: 0,
  });
  const pending = await call("create_post", { topic: "Useful software tools" });
  expect(pending.performance.recent_posts[0]).toMatchObject({
    metrics: { impressions: 1000 },
    refresh_status: "pending",
  });
  expect(
    (
      await env.DB.prepare("SELECT COUNT(*) AS n FROM metric_snapshots").first<{
        n: number;
      }>()
    )?.n,
  ).toBe(1);
  expect(fetchSpy).not.toHaveBeenCalled();
});
it("isolates voice memory and revisions by owner and supports explicit forgetting", async () => {
  const own = new VoiceService(bindings, "one");
  const foreign = new VoiceService(bindings, "two");
  const result = await own.manage({
    action: "add_example",
    text: "Private example",
    notes: "",
  });
  const example = result.examples[0] as { id: string };
  await foreign.manage({ action: "delete_example", example_id: example.id });
  expect((await own.read()).examples).toHaveLength(1);
  expect((await foreign.read()).examples).toHaveLength(0);
  await own.manage({ action: "reset" });
  expect((await own.read()).examples).toHaveLength(0);
});
it("returns X-informed guidance without scores; simulates only supplied probabilities and does not treat missing inputs as zero", async () => {
  const checks = await call("evaluate_post", {
    topic: "Tools",
    candidates: [
      { id: "a", text: "A useful tool solves one specific problem." },
    ],
  });
  expect(checks.ranking_guidance.source_commit).toHaveLength(40);
  expect(checks.ranking_simulation).toBeNull();
  expect(checks.recommended_id).toBeNull();
  const missing = await call("evaluate_post", {
    topic: "Tools",
    candidates: [
      { id: "a", text: "A useful tool solves one specific problem." },
    ],
    ranking_predictions: [
      { id: "a", source: "client_estimate", signals: { favorite: 0.5 } },
    ],
  });
  expect(missing.ranking_simulation.scenarios[0].weighted_sum).toBeNull();
  expect(missing.ranking_simulation.preferred_scenario_id).toBeNull();
  const signals = Object.fromEntries(
    Object.keys(rankingWeights).map((k) => [k, 0]),
  );
  Object.assign(signals, {
    favorite: 0.5,
    reply: 0.5,
    share_via_copy_link: 0.1,
    report: 0.01,
    dwell_time: 10,
  });
  const simulated = await call("evaluate_post", {
    topic: "Tools",
    candidates: [
      { id: "a", text: "A useful tool solves one specific problem." },
    ],
    ranking_predictions: [{ id: "a", source: "client_estimate", signals }],
  });
  expect(simulated.ranking_simulation.scenarios[0].weighted_sum).toBeCloseTo(
    2.45,
  );
  expect(simulated.ranking_simulation.preferred_scenario_id).toBe("a");
  const incompleteCoverage = await call("evaluate_post", {
    topic: "Tools",
    candidates: [
      { id: "a", text: "Useful tools solve problems." },
      { id: "b", text: "Start with the problem." },
    ],
    ranking_predictions: [{ id: "a", source: "client_estimate", signals }],
  });
  expect(incompleteCoverage.ranking_simulation.missing_candidate_ids).toEqual([
    "b",
  ]);
  expect(
    incompleteCoverage.ranking_simulation.preferred_scenario_id,
  ).toBeNull();
  expect(
    evaluateSchema.safeParse({
      topic: "Tools",
      candidates: [{ id: "a", text: "Text" }],
      ranking_predictions: [
        { id: "a", source: "client_estimate", signals: { favorite: 40 } },
      ],
    }).success,
  ).toBe(false);
});
