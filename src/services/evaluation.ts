import { z } from "zod";
import type { Candidate, Evidence } from "../domain/contracts";
import { dimensions, RUBRIC, validatePost } from "../domain/post";
import {
  OpenAIProvider,
  objectSchema,
  stringsSchema,
} from "../providers/openai";
import { AppError, hash } from "../domain/errors";
const dimensionShape = Object.fromEntries(
  Object.entries(dimensions).map(([k, max]) => [k, z.number().min(0).max(max)]),
) as Record<keyof typeof dimensions, z.ZodNumber>;
const assessment = z.object({
  id: z.string(),
  dimensions: z.object(dimensionShape),
  factuality: z.boolean(),
  safety: z.boolean(),
  originality: z.boolean(),
  issues: z.array(z.string()).max(8),
  strengths: z.array(z.string()).max(8),
});
const output = z.object({ assessments: z.array(assessment).min(1).max(4) });
const json = objectSchema({
  assessments: {
    type: "array",
    items: objectSchema({
      id: { type: "string" },
      dimensions: objectSchema(
        Object.fromEntries(
          Object.entries(dimensions).map(([k, max]) => [
            k,
            { type: "number", minimum: 0, maximum: max },
          ]),
        ),
      ),
      factuality: { type: "boolean" },
      safety: { type: "boolean" },
      originality: { type: "boolean" },
      issues: stringsSchema,
      strengths: stringsSchema,
    }),
  },
});
export class EvaluationService {
  constructor(private model: OpenAIProvider) {}
  async evaluate(
    topic: string,
    candidates: Candidate[],
    audience: string,
    intent: string,
    constraints: { must_include: string[]; avoid: string[] },
    evidence: Evidence[] = [],
    evergreenOnly = false,
  ) {
    const evaluated = await this.model.structured(
      "evaluation",
      output,
      json,
      "Evaluate every candidate once against rubric-1.0. Relevance 20, honest hook 20, clarity 15, useful value 20, shareability 15, substantive discussion 10. These are heuristic quality scores. Factuality must fail for unsupported statistics, quotes, specific current claims, or claims not supported by supplied evidence; snippets alone are not corroboration. With evergreen_only true, only timeless advice/opinion is allowed. Safety must fail spam, manipulation, dangerous instructions. Originality must fail copied source wording. Return the exact supplied IDs.",
      {
        topic,
        candidates,
        audience,
        intent,
        constraints,
        evidence,
        evergreen_only: evergreenOnly,
      },
    );
    if (
      evaluated.assessments.length !== candidates.length ||
      new Set(evaluated.assessments.map((a) => a.id)).size !==
        candidates.length ||
      evaluated.assessments.some((a) => !candidates.some((c) => c.id === a.id))
    )
      throw new AppError(
        "GENERATION_FAILED",
        "Evaluation IDs did not match the candidate batch.",
      );
    const ranked = await Promise.all(
      evaluated.assessments.map(async (a) => {
        const candidate = candidates.find((c) => c.id === a.id)!;
        const validated = validatePost(candidate.text, constraints);
        const hard_gates = {
          length: validated.length,
          constraints: validated.constraints,
          factuality: a.factuality,
          safety: a.safety,
          originality: a.originality,
        };
        return {
          id: a.id,
          text_hash: await hash(candidate.text),
          quality_score: Object.values(a.dimensions).reduce((a, b) => a + b, 0),
          dimensions: a.dimensions,
          hard_gates,
          eligible: Object.values(hard_gates).every(Boolean),
          issues: a.issues,
          strengths: a.strengths,
        };
      }),
    );
    ranked.sort(
      (a, b) =>
        Number(b.eligible) - Number(a.eligible) ||
        b.quality_score - a.quality_score,
    );
    return {
      rubric_version: RUBRIC,
      type: "heuristic_quality_assessment",
      ranked_candidates: ranked,
      recommended_id: ranked.find((r) => r.eligible)?.id ?? null,
    };
  }
}
