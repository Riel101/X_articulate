import { z } from "zod";
const short = z.string().trim().min(1).max(300);
export const constraintsSchema = z.object({
  must_include: z.array(short).max(10).default([]),
  avoid: z.array(short).max(10).default([]),
});
export const createSchema = z
  .object({
    topic: short,
    audience: short.default("general readers"),
    tone: short.default("clear and conversational"),
    intent: short.default("educate"),
    language: z.string().min(2).max(30).default("en"),
    post_length_profile: z.literal("standard").default("standard"),
    must_include: z.array(short).max(10).default([]),
    avoid: z.array(short).max(10).default([]),
    current_information_required: z.enum(["auto", "yes", "no"]).default("auto"),
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
  text: z.string().min(1).max(2000),
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
  })
  .refine(
    (v) => new Set(v.candidates.map((c) => c.id)).size === v.candidates.length,
    "Candidate IDs must be unique",
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
  dimension_scores: z.object({
    relevance: z.number().min(0).max(20),
    hook: z.number().min(0).max(20),
    clarity: z.number().min(0).max(15),
    value: z.number().min(0).max(20),
    shareability: z.number().min(0).max(15),
    discussion: z.number().min(0).max(10),
  }),
  strengths: z.array(z.string().max(300)).max(6).default([]),
  caveats: z.array(z.string().max(300)).max(6).default([]),
  factuality_reviewed: z.boolean(),
  originality_reviewed: z.boolean(),
  safety_reviewed: z.boolean(),
});
export const finalizeSchema = z.object({
  brief_id: short,
  post_text: z.string().min(1).max(2000),
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
