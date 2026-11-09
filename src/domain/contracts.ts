import { z } from "zod";
import { rankingWeights, type RankingSignal } from "../services/ranking";
const short = z.string().trim().min(1).max(300);
export const constraintsSchema = z.object({
  must_include: z.array(short).max(10).default([]),
  avoid: z.array(short).max(10).default([]),
});
export const createSchema = z
  .object({
    topic: short,
    research_mode: z
      .enum(["auto", "off", "optional", "required"])
      .default("auto")
      .describe(
        "auto researches only explicitly current topics; off is for personal experience/opinion. optional never blocks writing; required needs usable web context.",
      ),
    revision_of: short.optional(),
    feedback: z.string().max(3000).optional(),
    audience: short.default("general readers"),
    tone: short.default("clear and conversational"),
    intent: short.default("educate"),
    language: z.string().min(2).max(30).default("en"),
    post_length_profile: z.literal("standard").default("standard"),
    must_include: z.array(short).max(10).default([]),
    avoid: z.array(short).max(10).default([]),
    current_information_required: z
      .enum(["auto", "yes", "no"])
      .default("auto")
      .describe(
        "Use auto by default. yes requires dated web evidence from the last seven days; use no for timeless advice or opinion that does not rely on current events.",
      ),
    idempotency_key: z.string().min(1).max(128).optional(),
  })
  .superRefine((v, c) => {
    if (
      v.must_include.some((s) =>
        v.avoid.some((a) => s.toLowerCase().includes(a.toLowerCase())),
      )
    )
      c.addIssue({ code: "custom", message: "must_include contradicts avoid" });
  });
export type CreateInput = z.infer<typeof createSchema>;
export const candidateSchema = z.object({
  id: z.string().min(1).max(80),
  text: z.string().min(1),
});
export type Candidate = z.infer<typeof candidateSchema>;
export const researchSchema = z.object({
  topic: short,
  audience: short.optional(),
  freshness: z.enum(["auto", "recent", "evergreen"]).default("auto"),
  max_insights: z.number().int().min(1).max(5).default(5),
});
export const bankSchema = z.object({
  topic: short,
  audience: short.optional(),
  limit: z.number().int().min(1).max(10).default(5),
  window_hours: z.number().int().min(1).max(720).default(48),
});
export const evaluateSchema = z
  .object({
    topic: short,
    candidates: z.array(candidateSchema).min(1).max(4),
    audience: short.default("general readers"),
    intent: short.default("educate"),
    constraints: constraintsSchema.default({ must_include: [], avoid: [] }),
    ranking_predictions: z
      .array(
        z.object({
          id: z.string().min(1).max(80),
          source: z.enum(["client_estimate", "external_model"]),
          signals: z
            .partialRecord(
              z.enum(
                Object.keys(rankingWeights) as [
                  RankingSignal,
                  ...RankingSignal[],
                ],
              ),
              z.number().finite().min(0),
            )
            .superRefine((values, ctx) => {
              for (const [key, value] of Object.entries(values))
                if (
                  ![
                    "dwell_time",
                    "click_dwell_time",
                    "video_continuation",
                    "user_video_continuation",
                    "profile_visit_secs",
                  ].includes(key) &&
                  value! > 1
                )
                  ctx.addIssue({
                    code: "custom",
                    path: [key],
                    message: "Action probabilities must be between 0 and 1.",
                  });
            }),
        }),
      )
      .max(4)
      .optional()
      .describe(
        "Optional hypothetical per-viewer predictions, never raw counts. Omit unless explicitly simulating a scenario; estimates are uncalibrated.",
      ),
  })
  .refine(
    (v) => new Set(v.candidates.map((c) => c.id)).size === v.candidates.length,
    "Candidate IDs must be unique",
  )
  .refine(
    (v) =>
      !v.ranking_predictions ||
      (new Set(v.ranking_predictions.map((p) => p.id)).size ===
        v.ranking_predictions.length &&
        v.ranking_predictions.every((p) =>
          v.candidates.some((c) => c.id === p.id),
        )),
    "Ranking scenario IDs must be unique and match candidate IDs.",
  );
export const registerSchema = z.object({
  draft_id: short,
  x_post_url_or_id: z.string().min(1).max(300),
  actual_published_text: z.string().min(1).max(25000).optional(),
  published_at: z.string().datetime().optional(),
});
export const performanceSchema = z.object({
  published_post_id: short,
  refresh: z.boolean().default(true),
});
export const reportSchema = z.object({
  topic: short.optional(),
  audience: short.optional(),
  window_hours: z.number().int().min(1).max(720).default(48),
});
export interface Evidence {
  id: string;
  kind: "x_post" | "web" | "official" | "news";
  provider: string;
  title?: string;
  url: string;
  excerpt: string;
  author?: string;
  publishedAt?: string;
  retrievedAt: string;
  claims: string[];
  verification: "corroborated" | "single_source" | "unverified";
}
export interface ResearchResult {
  status: "verified" | "partial" | "evergreen_only" | "unavailable";
  angles: string[];
  evidence: Evidence[];
  warnings: string[];
  providers_used: string[];
}

export const clientAssessmentSchema = z.object({
  dimension_scores: z
    .object({
      relevance: z.number().min(0).max(20),
      hook: z.number().min(0).max(20),
      clarity: z.number().min(0).max(15),
      value: z.number().min(0).max(20),
      shareability: z.number().min(0).max(15),
      discussion: z.number().min(0).max(10),
    })
    .optional()
    .describe("Legacy field; ignored by the editorial workflow."),
  summary: z.string().max(1200).default(""),
  improvements: z
    .array(
      z.object({
        problem: short,
        why: z.string().min(1).max(600),
        suggestion: z.string().min(1).max(1000),
      }),
    )
    .max(8)
    .default([]),
  ranking_review: z
    .object({
      audience_fit: z.string().max(1000),
      likely_positive_signals: z.array(short).max(8),
      likely_negative_signals: z.array(short).max(8),
      suggested_changes: z.array(z.string().max(1000)).max(8),
      uncertainty: z.string().max(1000),
    })
    .optional(),
  strengths: z.array(z.string().max(300)).max(6).default([]),
  caveats: z.array(z.string().max(300)).max(6).default([]),
  factuality_reviewed: z.boolean(),
  originality_reviewed: z.boolean(),
  safety_reviewed: z.boolean(),
});
export const finalizeSchema = z.object({
  brief_id: short,
  post_text: z.string().min(1),
  assessment: clientAssessmentSchema,
  client_model: z.string().min(1).max(100).default("unspecified"),
  claims: z
    .array(
      z.object({
        claim: z.string().min(1).max(500),
        source_ids: z.array(z.string().max(100)).min(1).max(5),
      }),
    )
    .max(5)
    .default([]),
});

export const voiceSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("read") }),
  z.object({
    action: z.literal("update_preferences"),
    preferences: z.object({
      style: z.array(short).max(20).default([]),
      avoid: z.array(short).max(20).default([]),
      audience: short.optional(),
    }),
  }),
  z.object({
    action: z.literal("add_example"),
    text: z.string().trim().min(1).max(15000),
    notes: z.string().max(2000).default(""),
  }),
  z.object({ action: z.literal("delete_example"), example_id: short }),
  z.object({ action: z.literal("reset") }),
]);
