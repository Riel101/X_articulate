import { z } from "zod";
import type { Env } from "../config/env";
import { candidateSchema, type CreateInput } from "../domain/contracts";
import { AppError, hash, id } from "../domain/errors";
import { features, RUBRIC, validatePost } from "../domain/post";
import { OpenAIProvider, objectSchema } from "../providers/openai";
import { BankRepository } from "../repositories/bank";
import { EvaluationService } from "./evaluation";
import { ResearchOrchestrator } from "./research";
const generation = z
  .object({
    candidates: z.array(candidateSchema).length(4),
    claims: z
      .array(
        z.object({
          claim: z.string().min(1).max(500),
          source_ids: z.array(z.string()).min(1).max(5),
        }),
      )
      .max(5)
      .default([]),
  })
  .refine(
    (v) =>
      new Set(v.candidates.map((c) => c.id)).size === 4 &&
      new Set(v.candidates.map((c) => c.text.trim())).size === 4,
    "Candidates must be distinct",
  );
const candidateJson = objectSchema({
  id: { type: "string" },
  text: { type: "string" },
});
export class CreatePostWorkflow {
  constructor(
    private env: Env,
    private bank: BankRepository,
  ) {}
  async run(input: CreateInput, requestId: string) {
    const inputHash = await hash(
      JSON.stringify({ ...input, idempotency_key: undefined }),
    );
    if (input.idempotency_key) {
      const existing = await this.bank.replay(input.idempotency_key);
      if (existing) {
        if (existing.input_hash !== inputHash)
          throw new AppError(
            "INVALID_INPUT",
            "Idempotency key was already used for different input.",
          );
        return JSON.parse(existing.response_json) as Record<string, unknown>;
      }
    }
    const lock = `create:${input.idempotency_key ?? requestId}`;
    await this.bank.acquire(lock);
    try {
      // Re-check after acquiring the durable lock to close concurrent replay races.
      if (input.idempotency_key) {
        const replay = await this.bank.replay(input.idempotency_key);
        if (replay) {
          if (replay.input_hash !== inputHash)
            throw new AppError(
              "INVALID_INPUT",
              "Idempotency key was already used for different input.",
            );
          return JSON.parse(replay.response_json) as Record<string, unknown>;
        }
      }
      const [research, learning] = await Promise.all([
        new ResearchOrchestrator(this.env).research(
          input.topic,
          input.current_information_required === "yes"
            ? "recent"
            : input.current_information_required === "no"
              ? "evergreen"
              : "auto",
        ),
        this.bank.insights(input.topic, input.audience),
      ]);
      if (research.status === "unavailable")
        throw new AppError(
          "RESEARCH_UNAVAILABLE",
          "Current information could not be researched. Retry when a research provider is available.",
          true,
        );
      if (
        input.current_information_required === "yes" &&
        !research.evidence.some(
          (e) =>
            e.kind === "web" &&
            e.publishedAt &&
            Date.now() - Date.parse(e.publishedAt) < 7 * 86400000,
        )
      )
        throw new AppError(
          "RESEARCH_UNAVAILABLE",
          "No dated web evidence supports a current-information post. Retry with a narrower topic.",
          true,
        );
      const model = new OpenAIProvider(this.env);
      const evaluator = new EvaluationService(model);
      const brief = {
        preferences: input,
        research,
        historical_patterns: learning.patterns,
      };
      const generated = await model.structured(
        "candidates",
        generation,
        objectSchema({
          candidates: {
            type: "array",
            minItems: 4,
            maxItems: 4,
            items: candidateJson,
          },
          claims: {
            type: "array",
            maxItems: 5,
            items: objectSchema({
              claim: { type: "string" },
              source_ids: {
                type: "array",
                minItems: 1,
                maxItems: 5,
                items: { type: "string" },
              },
            }),
          },
        }),
        "Extract at most five factual insights with source_ids referencing supplied web evidence IDs (empty claims for evergreen fallback). Never invent source IDs. Then write four DISTINCT original X posts with distinct hooks. Each must fit 280 weighted characters (URLs count 23, emoji normally 2). Respect language and every constraint. No citations or analytics in text. With evergreen_only research, write timeless advice/opinion only. Use web evidence cautiously; X posts are conversation context, never factual proof.",
        brief,
      );
      for (const claim of generated.claims) {
        for (const sourceId of claim.source_ids) {
          const source = research.evidence.find(
            (e) => e.id === sourceId && e.kind !== "x_post",
          );
          if (!source)
            throw new AppError(
              "GENERATION_FAILED",
              "A generated claim referenced an unknown or ineligible source.",
            );
          source.claims.push(claim.claim);
        }
      }
      let candidates = generated.candidates;
      let evaluation = await evaluator.evaluate(
        input.topic,
        candidates,
        input.audience,
        input.intent,
        input,
        research.evidence,
        research.status === "evergreen_only",
      );
      for (
        let attempt = 0;
        !evaluation.recommended_id && attempt < 2;
        attempt++
      ) {
        const revised = await model.structured(
          "revision",
          candidateSchema,
          candidateJson,
          "Repair the supplied candidate to pass every failed gate. Preserve user constraints. Return one original X post under 280 weighted characters. Do not truncate. Remove unsupported claims.",
          {
            brief,
            candidate: candidates[0],
            issues: evaluation.ranked_candidates,
          },
        );
        candidates = [revised];
        evaluation = await evaluator.evaluate(
          input.topic,
          candidates,
          input.audience,
          input.intent,
          input,
          research.evidence,
          research.status === "evergreen_only",
        );
      }
      if (!evaluation.recommended_id)
        throw new AppError(
          "VALIDATION_FAILED",
          "No candidate passed all factuality, length, originality, safety, and user-constraint gates. Try adjusting the topic or constraints.",
        );
      let winner = evaluation.ranked_candidates.find(
        (r) => r.id === evaluation.recommended_id,
      )!;
      let adjustment = false;
      // Historical fit only breaks close rubric ties; the quality score stays unchanged.
      if (learning.learning_status === "usable" && learning.patterns.length) {
        const close = evaluation.ranked_candidates.filter(
          (r) => r.eligible && winner.quality_score - r.quality_score <= 2,
        );
        const fit = (candidateId: string) =>
          learning.patterns.find(
            (p) =>
              p.hook ===
              features(candidates.find((c) => c.id === candidateId)!.text).hook,
          )?.smoothed_interaction_rate ?? -1;
        close.sort(
          (a, b) => fit(b.id) - fit(a.id) || b.quality_score - a.quality_score,
        );
        if (close[0] && fit(close[0].id) >= 0) {
          winner = close[0];
          adjustment = true;
        }
      }
      const candidate = candidates.find((c) => c.id === winner.id)!;
      const validation = validatePost(candidate.text, input);
      if (
        (await hash(candidate.text)) !== winner.text_hash ||
        !validation.length ||
        !validation.constraints
      )
        throw new AppError(
          "VALIDATION_FAILED",
          "Final post no longer matches its evaluation.",
        );
      const draftId = id("drf");
      const now = new Date().toISOString();
      const response = {
        draft_id: draftId,
        ready_to_copy: true,
        post_text: candidate.text,
        pre_publication_analytics: {
          type: "heuristic_quality_assessment",
          quality_score: winner.quality_score,
          scoring_version: RUBRIC,
          dimension_scores: winner.dimensions,
          weighted_characters: validation.weighted_characters,
          character_limit: 280,
          strengths: winner.strengths,
          caveats: [
            "Quality score is not a prediction of impressions or virality.",
            "Factuality checks are model assessments, not independent fact-checking.",
          ],
        },
        research: {
          status: research.status,
          sources: research.evidence,
          warnings: research.warnings,
        },
        learning: {
          status: learning.learning_status,
          comparable_post_count: learning.sample_size,
          scoring_adjustment_applied: adjustment,
          algorithm_version: "cohort-1.0",
          window_hours: 48,
        },
        validation: { length: "pass", factuality: "pass", constraints: "pass" },
      };
      const sql = this.env.DB;
      await sql.batch([
        sql
          .prepare(
            "INSERT INTO drafts(id,owner_id,topic,audience,tone,intent,language,final_text,text_hash,features_json,created_at,status,request_id,input_hash,response_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
          )
          .bind(
            draftId,
            this.bank.owner,
            input.topic.trim().toLowerCase(),
            input.audience,
            input.tone,
            input.intent,
            input.language,
            candidate.text,
            winner.text_hash,
            JSON.stringify(features(candidate.text)),
            now,
            "generated",
            input.idempotency_key ?? null,
            inputHash,
            JSON.stringify(response),
          ),
        ...evaluation.ranked_candidates.map((r) =>
          sql
            .prepare(
              "INSERT INTO evaluations(id,draft_id,candidate_id,score,dimensions_json,hard_gates_json,rubric_version,model_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
            )
            .bind(
              id("evl"),
              draftId,
              r.id,
              r.quality_score,
              JSON.stringify(r.dimensions),
              JSON.stringify(r.hard_gates),
              RUBRIC,
              this.env.OPENAI_MODEL,
              now,
            ),
        ),
        ...research.evidence.map((e) =>
          sql
            .prepare("INSERT INTO research_sources VALUES(?,?,?,?,?,?,?,?,?)")
            .bind(
              id("src"),
              draftId,
              e.provider,
              e.kind,
              e.url,
              JSON.stringify({ excerpt: e.excerpt, claims: e.claims }),
              e.verification,
              e.retrievedAt,
              e.publishedAt ?? null,
            ),
        ),
      ]);
      return response;
    } finally {
      await this.bank.release(lock);
    }
  }
}
