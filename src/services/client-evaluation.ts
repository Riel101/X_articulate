import type { z } from "zod";
import type { evaluateSchema } from "../domain/contracts";
import { hash } from "../domain/errors";
import { RUBRIC, validatePost } from "../domain/post";
import { rankingGuidance, simulateRanking } from "./ranking";
export async function validateClientCandidates(
  input: z.infer<typeof evaluateSchema>,
) {
  const ranked = await Promise.all(
    input.candidates.map(async (c) => {
      const validation = validatePost(c.text, input.constraints);
      return {
        id: c.id,
        text_hash: await hash(c.text),
        quality_score: null,
        dimensions: null,
        eligible: false,
        deterministic_valid: validation.length && validation.constraints,
        weighted_characters: validation.weighted_characters,
        hard_gates: {
          length: validation.length,
          constraints: validation.constraints,
          factuality: "requires_client_review",
          originality: "requires_client_review",
          safety: "requires_client_review",
        },
        issues: [
          ...(!validation.length ? ["Repair empty or invalid text."] : []),
          ...(!validation.constraints
            ? ["Repair must_include/avoid constraints."]
            : []),
        ],
        strengths: [],
      };
    }),
  );
  ranked.sort(
    (a, b) => Number(b.deterministic_valid) - Number(a.deterministic_valid),
  );
  return {
    type: "deterministic_validation_only",
    rubric_version: RUBRIC,
    ranked_candidates: ranked,
    recommended_id: null,
    ranking_guidance: rankingGuidance,
    ranking_simulation: input.ranking_predictions
      ? simulateRanking(
          input.ranking_predictions,
          ranked.filter((c) => c.deterministic_valid).map((c) => c.id),
          input.candidates.map((c) => c.id),
        )
      : null,
    instructions:
      "Use your own model to review and compare candidates using ranking_guidance, the author voice and observed account context. Explain weaknesses and offer concrete rewritten passages; recommend a candidate qualitatively. The server checked text validity and explicit constraints only. Do not invent algorithm scores or reach predictions. Finalize the chosen post with your editorial review.",
    requires_server_model_key: false,
  };
}
