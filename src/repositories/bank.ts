import type { Env } from "../config/env";
import { AppError, id } from "../domain/errors";
import { rates, type Metrics } from "../domain/post";
export interface Draft {
  id: string;
  owner_id: string;
  topic: string;
  audience: string;
  final_text: string;
  response_json: string;
  input_hash: string;
}
export interface Publication {
  id: string;
  draft_id: string;
  account_id: string;
  x_post_id: string;
  actual_text: string;
  published_at: string;
  provider_post_id: string | null;
  verification: string;
}
interface Comparable {
  id: string;
  topic: string;
  audience: string;
  features_json: string;
  metrics_json: string;
  observed_at: string;
  post_age_hours: number;
}
export class BankRepository {
  constructor(
    public env: Env,
    public owner: string,
  ) {}
  async draft(draftId: string) {
    return this.env.DB.prepare("SELECT * FROM drafts WHERE id=? AND owner_id=?")
      .bind(draftId, this.owner)
      .first<Draft>();
  }
  async replay(key: string) {
    return this.env.DB.prepare(
      "SELECT * FROM drafts WHERE owner_id=? AND request_id=?",
    )
      .bind(this.owner, key)
      .first<Draft>();
  }
  async publication(locator: string) {
    return this.env.DB.prepare(
      "SELECT p.* FROM published_posts p JOIN accounts a ON a.id=p.account_id WHERE a.owner_id=? AND (p.id=? OR p.x_post_id=?)",
    )
      .bind(this.owner, locator, locator)
      .first<Publication>();
  }
  async account() {
    if (!this.env.ZERNIO_ACCOUNT_ID || !this.env.X_USERNAME)
      throw new AppError(
        "FORBIDDEN",
        "Configure the authorized ZERNIO_ACCOUNT_ID and X_USERNAME before linking posts.",
      );
    await this.env.DB.prepare(
      "INSERT INTO accounts(id,owner_id,zernio_account_id,x_username,created_at) VALUES(?,?,?,?,?) ON CONFLICT(owner_id) DO NOTHING",
    )
      .bind(
        `acc_${this.owner}`,
        this.owner,
        this.env.ZERNIO_ACCOUNT_ID,
        this.env.X_USERNAME,
        new Date().toISOString(),
      )
      .run();
    const account = await this.env.DB.prepare(
      "SELECT * FROM accounts WHERE owner_id=?",
    )
      .bind(this.owner)
      .first<{ id: string; zernio_account_id: string }>();
    if (!account || account.zernio_account_id !== this.env.ZERNIO_ACCOUNT_ID)
      throw new AppError(
        "FORBIDDEN",
        "The configured account changed. Migrate the owner mapping explicitly.",
      );
    return account;
  }
  async comparable(
    topic: string | undefined,
    audience: string | undefined,
    window: number,
  ) {
    // One snapshot per verified owned post, within +/-25% of the same observation age.
    const rows = await this.env.DB.prepare(
      `SELECT p.id,d.topic,d.audience,p.features_json,m.metrics_json,m.observed_at,m.post_age_hours FROM published_posts p JOIN accounts a ON a.id=p.account_id JOIN drafts d ON d.id=p.draft_id JOIN metric_snapshots m ON m.published_post_id=p.id WHERE a.owner_id=? AND p.verification='verified' AND (? IS NULL OR d.topic=?) AND (? IS NULL OR d.audience=?) AND m.post_age_hours BETWEEN ? AND ? AND m.id=(SELECT m2.id FROM metric_snapshots m2 WHERE m2.published_post_id=p.id AND m2.post_age_hours BETWEEN ? AND ? ORDER BY ABS(m2.post_age_hours-?),m2.observed_at DESC,m2.id LIMIT 1) ORDER BY m.observed_at DESC LIMIT 300`,
    )
      .bind(
        this.owner,
        topic?.trim().toLowerCase() ?? null,
        topic?.trim().toLowerCase() ?? null,
        audience ?? null,
        audience ?? null,
        window * 0.75,
        window * 1.25,
        window * 0.75,
        window * 1.25,
        window,
      )
      .all<Comparable>();
    return rows.results.filter(
      (r) =>
        rates(JSON.parse(r.metrics_json) as Metrics)
          .observed_interaction_rate !== null,
    );
  }
  async insights(
    topic: string,
    audience: string | undefined,
    limit = 5,
    window = 48,
  ) {
    const rows = await this.comparable(
      topic,
      audience ?? "general readers",
      window,
    );
    const usable = rows.length >= 30;
    const values = rows
      .map(
        (r) =>
          rates(JSON.parse(r.metrics_json) as Metrics)
            .observed_interaction_rate!,
      )
      .sort((a, b) => a - b);
    const median = values.length ? values[Math.floor(values.length / 2)] : null;
    const groups = new Map<string, number[]>();
    for (const row of rows) {
      const hook = String(JSON.parse(row.features_json).hook);
      groups.set(hook, [
        ...(groups.get(hook) ?? []),
        rates(JSON.parse(row.metrics_json)).observed_interaction_rate!,
      ]);
    }
    const patterns = usable
      ? [...groups]
          .filter(([, v]) => v.length >= 10)
          .map(([hook, v]) => ({
            hook,
            sample_size: v.length,
            smoothed_interaction_rate:
              (v.reduce((a, b) => a + b, 0) + 10 * median!) / (v.length + 10),
            association_only: true,
          }))
      : [];
    return {
      patterns,
      examples: rows.slice(0, limit).map((r) => ({
        post_id: r.id,
        summary: `${r.topic}; ${r.audience}; ${JSON.parse(r.features_json).hook} hook`,
        metrics: JSON.parse(r.metrics_json) as Metrics,
        observed_at: r.observed_at,
      })),
      sample_size: rows.length,
      learning_status: usable
        ? ("usable" as const)
        : ("insufficient_data" as const),
      window_hours: window,
      median_interaction_rate: median,
    };
  }
  async report(
    topic: string | undefined,
    audience: string | undefined,
    window: number,
  ) {
    const rows = await this.comparable(topic, audience, window);
    const total = await this.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM published_posts p JOIN accounts a ON a.id=p.account_id WHERE a.owner_id=?",
    )
      .bind(this.owner)
      .first<{ n: number }>();
    const grouped = new Map<string, Comparable[]>();
    for (const row of rows) {
      const key = JSON.stringify([row.topic, row.audience, "single"]);
      grouped.set(key, [...(grouped.get(key) ?? []), row]);
    }
    const cohorts = [...grouped].map(([key, posts]) => {
      const values = posts
        .map(
          (p) => rates(JSON.parse(p.metrics_json)).observed_interaction_rate!,
        )
        .sort((a, b) => a - b);
      return {
        cohort_key: key,
        sample_size: posts.length,
        window_hours: window,
        median_interaction_rate: values[Math.floor(values.length / 2)],
        learning_status: posts.length >= 30 ? "usable" : "insufficient_data",
      };
    });
    return {
      total_published_posts: total?.n ?? 0,
      posts_with_usable_metrics: rows.length,
      cohorts,
      scoring_version: "rubric-1.0",
      algorithm_version: "cohort-1.0",
      learning_status: cohorts.some((c) => c.learning_status === "usable")
        ? "usable"
        : "insufficient_data",
      recommendations: cohorts.some((c) => c.learning_status === "usable")
        ? [
            "Descriptive associations only; account, topic, and timing may explain outcomes.",
          ]
        : [
            "Collect at least 30 comparable owned posts with all interaction fields and positive impressions in the same age window.",
          ],
    };
  }
  async refresh(topic: string, audience: string) {
    const insight = await this.insights(topic, audience);
    await this.env.DB.prepare(
      "INSERT INTO learning_summaries(id,owner_id,cohort_key,window_hours,sample_size,summary_json,algorithm_version,computed_at,stale) VALUES(?,?,?,?,?,?,?,?,0) ON CONFLICT(owner_id,cohort_key,window_hours) DO UPDATE SET sample_size=excluded.sample_size,summary_json=excluded.summary_json,computed_at=excluded.computed_at,stale=0",
    )
      .bind(
        id("lrn"),
        this.owner,
        JSON.stringify([topic, audience, "single"]),
        48,
        insight.sample_size,
        JSON.stringify(insight),
        "cohort-1.0",
        new Date().toISOString(),
      )
      .run();
  }
  async acquire(key: string) {
    const now = new Date().toISOString();
    const result = await this.env.DB.prepare(
      "INSERT INTO request_locks(owner_id,request_key,expires_at) VALUES(?,?,?) ON CONFLICT(owner_id,request_key) DO UPDATE SET expires_at=excluded.expires_at WHERE request_locks.expires_at<?",
    )
      .bind(this.owner, key, new Date(Date.now() + 240000).toISOString(), now)
      .run();
    if (!result.meta.changes)
      throw new AppError(
        "RATE_LIMITED",
        "This request is already running. Retry shortly with the same idempotency key.",
        true,
      );
  }
  async release(key: string) {
    await this.env.DB.prepare(
      "DELETE FROM request_locks WHERE owner_id=? AND request_key=?",
    )
      .bind(this.owner, key)
      .run();
  }
}
