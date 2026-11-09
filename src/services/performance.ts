import type { Env } from "../config/env";
import type { registerSchema } from "../domain/contracts";
import type { z } from "zod";
import { AppError, hash, id } from "../domain/errors";
import {
  features,
  metricKeys,
  parseXId,
  rates,
  RUBRIC,
  type Metrics,
} from "../domain/post";
import { ZernioProvider } from "../providers/zernio";
import { BankRepository } from "../repositories/bank";
import { OpenAIProvider } from "../providers/openai";
import { EvaluationService } from "./evaluation";
export class PerformanceService {
  constructor(
    private env: Env,
    private bank: BankRepository,
  ) {}
  async register(input: z.infer<typeof registerSchema>) {
    const xId = parseXId(input.x_post_url_or_id);
    if (!xId)
      throw new AppError(
        "INVALID_INPUT",
        "Supply a numeric X post ID or an HTTPS x.com status URL.",
      );
    const lock = `link:${xId}`;
    await this.bank.acquire(lock);
    try {
      const draft = await this.bank.draft(input.draft_id);
      if (!draft)
        throw new AppError(
          "FORBIDDEN",
          "Draft is not available to this owner.",
        );
      const account = await this.bank.account();
      const existing = await this.bank.publication(xId);
      if (existing) {
        if (existing.draft_id !== draft.id)
          throw new AppError(
            "INVALID_INPUT",
            "This X post is already linked to another draft.",
          );
        return {
          published_post_id: existing.id,
          x_post_id: xId,
          status: "linked",
          edited_from_draft: existing.actual_text !== draft.final_text,
          verification: existing.verification,
          metrics_available: false,
        };
      }
      const verified = await new ZernioProvider(this.env).verify(xId);
      if (
        input.actual_published_text &&
        input.actual_published_text !== verified.text
      )
        throw new AppError(
          "INVALID_INPUT",
          "Supplied text differs from the text verified by the provider.",
        );
      if (
        input.published_at &&
        Math.abs(
          Date.parse(input.published_at) - Date.parse(verified.publishedAt),
        ) > 60000
      )
        throw new AppError(
          "INVALID_INPUT",
          "Supplied publication time differs from the verified publication time.",
        );
      const edited = verified.text !== draft.final_text;
      const postId = id("pub");
      const actualEvaluation =
        edited && this.env.GENERATION_MODE === "server"
          ? await new EvaluationService(new OpenAIProvider(this.env)).evaluate(
              draft.topic,
              [{ id: postId, text: verified.text }],
              draft.audience,
              "evaluate actual published text",
              { must_include: [], avoid: [] },
              [],
              false,
            )
          : null;
      await this.env.DB.batch([
        this.env.DB.prepare(
          "INSERT INTO published_posts(id,draft_id,account_id,x_post_id,x_post_url,actual_text,actual_text_hash,features_json,published_at,edited_from_draft,verification,provider_post_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id,x_post_id) DO NOTHING",
        ).bind(
          postId,
          draft.id,
          account.id,
          xId,
          `https://x.com/${this.env.X_USERNAME!.replace(/^@/, "")}/status/${xId}`,
          verified.text,
          await hash(verified.text),
          JSON.stringify(features(verified.text)),
          verified.publishedAt,
          Number(edited),
          "verified",
          verified.providerId,
          new Date().toISOString(),
        ),
        this.env.DB.prepare(
          "UPDATE drafts SET status='published' WHERE id=? AND owner_id=?",
        ).bind(draft.id, this.bank.owner),
        ...(actualEvaluation
          ? actualEvaluation.ranked_candidates.map((r) =>
              this.env.DB.prepare(
                "INSERT INTO evaluations(id,draft_id,candidate_id,score,dimensions_json,hard_gates_json,rubric_version,model_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
              ).bind(
                id("evl"),
                draft.id,
                postId,
                r.quality_score,
                JSON.stringify(r.dimensions),
                JSON.stringify(r.hard_gates),
                RUBRIC,
                (this.env.MODEL_PROVIDER === "nvidia"
                  ? this.env.NVIDIA_MODEL
                  : this.env.OPENAI_MODEL) ?? "unconfigured",
                new Date().toISOString(),
              ),
            )
          : []),
      ]);
      const saved = await this.bank.publication(xId);
      if (!saved || saved.draft_id !== draft.id)
        throw new AppError(
          "INVALID_INPUT",
          "This post was linked to another draft concurrently.",
        );
      return {
        published_post_id: saved.id,
        x_post_id: xId,
        status: "linked",
        edited_from_draft: edited,
        verification: "verified",
        metrics_available: false,
      };
    } finally {
      await this.bank.release(lock);
    }
  }
  async get(locator: string, refresh: boolean) {
    const post = await this.bank.publication(parseXId(locator) ?? locator);
    if (!post)
      throw new AppError(
        "POST_NOT_LINKED",
        "Link a published post owned by this account before requesting performance.",
      );
    await this.bank.account();
    if (!refresh) {
      const cached = await this.env.DB.prepare(
        "SELECT * FROM metric_snapshots WHERE published_post_id=? ORDER BY observed_at DESC,id DESC LIMIT 1",
      )
        .bind(post.id)
        .first<{
          observed_at: string;
          post_age_hours: number;
          metrics_json: string;
          missing_fields_json: string;
        }>();
      if (cached)
        return {
          status: "ok",
          published_post_id: post.id,
          source: "zernio",
          cached: true,
          observed_at: cached.observed_at,
          post_age_hours: cached.post_age_hours,
          metrics: JSON.parse(cached.metrics_json) as Metrics,
          missing_fields: JSON.parse(cached.missing_fields_json),
          derived_rates: rates(JSON.parse(cached.metrics_json)),
          reference_bank: {
            updated: false,
            new_snapshot: false,
            learning_summary_refreshed: false,
          },
        };
      return {
        status: "unavailable",
        published_post_id: post.id,
        reference_bank: {
          updated: false,
          new_snapshot: false,
          learning_summary_refreshed: false,
        },
        message: "No saved observation. Use refresh: true.",
      };
    }
    const fetched = await new ZernioProvider(this.env).metrics(
      post.provider_post_id ?? post.x_post_id,
      post.x_post_id,
      post.published_at,
    );
    if (fetched.status !== "ok")
      return {
        status: fetched.status,
        published_post_id: post.id,
        retry_after_seconds: fetched.status === "pending" ? 60 : undefined,
        reference_bank: {
          updated: false,
          new_snapshot: false,
          learning_summary_refreshed: false,
        },
      };
    const now = new Date().toISOString();
    const age = (Date.parse(now) - Date.parse(post.published_at)) / 3600000;
    if (age < 0)
      throw new AppError(
        "METRICS_UNAVAILABLE",
        "Publication timestamp is in the future.",
      );
    const key = await hash(
      JSON.stringify([post.x_post_id, fetched.updatedAt, fetched.metrics]),
    );
    const missing = metricKeys.filter((k) => fetched.metrics[k] === null);
    const inserted = await this.env.DB.prepare(
      "INSERT INTO metric_snapshots(id,published_post_id,provider,provider_updated_at,observed_at,metrics_json,missing_fields_json,post_age_hours,ingestion_key) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(published_post_id,provider,ingestion_key) DO NOTHING",
    )
      .bind(
        id("met"),
        post.id,
        "zernio",
        fetched.updatedAt,
        now,
        JSON.stringify(fetched.metrics),
        JSON.stringify(missing),
        age,
        key,
      )
      .run();
    // Dedupe returns the ORIGINAL timestamp/age, never a later artificial observation.
    const snapshot = await this.env.DB.prepare(
      "SELECT observed_at,post_age_hours FROM metric_snapshots WHERE published_post_id=? AND provider=? AND ingestion_key=?",
    )
      .bind(post.id, "zernio", key)
      .first<{ observed_at: string; post_age_hours: number }>();
    const draft = await this.bank.draft(post.draft_id);
    let refreshed = false;
    if (draft) {
      try {
        await this.bank.refresh(draft.topic, draft.audience);
        refreshed = true;
      } catch {
        await this.env.DB.prepare(
          "INSERT INTO learning_summaries(id,owner_id,cohort_key,window_hours,sample_size,summary_json,algorithm_version,computed_at,stale) VALUES(?,?,?,?,?,?,?,?,1) ON CONFLICT(owner_id,cohort_key,window_hours) DO UPDATE SET stale=1",
        )
          .bind(
            id("lrn"),
            this.bank.owner,
            JSON.stringify([draft.topic, draft.audience, "single"]),
            48,
            0,
            "{}",
            "cohort-1.0",
            now,
          )
          .run();
      }
    }
    return {
      status: "ok",
      published_post_id: post.id,
      source: "zernio",
      observed_at: snapshot!.observed_at,
      post_age_hours: snapshot!.post_age_hours,
      metrics: fetched.metrics,
      missing_fields: missing,
      derived_rates: rates(fetched.metrics),
      reference_bank: {
        updated: true,
        new_snapshot: inserted.meta.changes > 0,
        learning_summary_refreshed: refreshed,
      },
      comparison: draft
        ? await this.bank.insights(draft.topic, draft.audience, 5, 48)
        : {
            learning_status: "insufficient_data",
            sample_size: 0,
            window_hours: 48,
          },
    };
  }
}
