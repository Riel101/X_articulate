import type { z } from "zod";
import type { evaluateSchema } from "../domain/contracts";
import { hash } from "../domain/errors";
import { dimensions, RUBRIC, validatePost } from "../domain/post";
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
          ...(!validation.length ? ["Repair weighted X length."] : []),
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
    rubric: { dimension_maxima: dimensions },
    instructions:
      "Use your own model to score and review these candidates. The server checked length and explicit constraints only; null scores mean no model evaluation was performed. Finalize the chosen post with finalize_post.",
    requires_server_model_key: false,
  };
}
