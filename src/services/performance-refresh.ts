import type { Env } from "../config/env";
import { BankRepository } from "../repositories/bank";
import { PerformanceService } from "./performance";
export async function refreshPerformance(env: Env, owner = env.MCP_OWNER_ID) {
  if (!env.ZERNIO_API_KEY || !env.ZERNIO_ACCOUNT_ID || !env.X_USERNAME)
    return { status: "not_configured", attempted: 0, updated: 0 };
  const bank = new BankRepository(env, owner);
  try {
    await bank.acquire("scheduled-performance", 900000);
  } catch {
    return { status: "already_running", attempted: 0, updated: 0 };
  }
  try {
    const cutoff = new Date(Date.now() - 3600000).toISOString();
    const posts = await env.DB.prepare(
      "SELECT p.id FROM published_posts p JOIN accounts a ON a.id=p.account_id LEFT JOIN performance_refresh_state s ON s.published_post_id=p.id WHERE a.owner_id=? AND p.verification='verified' AND p.published_at>=? AND (s.attempted_at IS NULL OR s.attempted_at<=?) ORDER BY COALESCE(s.attempted_at,'') ASC,p.published_at DESC LIMIT 5",
    )
      .bind(owner, new Date(Date.now() - 30 * 86400000).toISOString(), cutoff)
      .all<{ id: string }>();
    let updated = 0;
    for (const post of posts.results) {
      const now = new Date().toISOString();
      await env.DB.prepare(
        "INSERT INTO performance_refresh_state VALUES(?,?,'started') ON CONFLICT(published_post_id) DO UPDATE SET attempted_at=excluded.attempted_at,status='started'",
      )
        .bind(post.id, now)
        .run();
      let status = "provider_unavailable";
      try {
        const result = await new PerformanceService(env, bank).get(
          post.id,
          true,
        );
        status = result.status;
        if (status === "ok") updated++;
      } catch {
        /* Retain prior observations; retry in the next hour. */
      }
      await env.DB.prepare(
        "UPDATE performance_refresh_state SET status=? WHERE published_post_id=?",
      )
        .bind(status, post.id)
        .run();
    }
    return { status: "complete", attempted: posts.results.length, updated };
  } finally {
    await bank.release("scheduled-performance");
  }
}
export async function performanceContext(env: Env, owner: string) {
  const rows = await env.DB.prepare(
    "SELECT p.id,p.actual_text,p.published_at,m.metrics_json,m.observed_at,s.attempted_at,s.status AS refresh_status FROM published_posts p JOIN accounts a ON a.id=p.account_id LEFT JOIN metric_snapshots m ON m.id=(SELECT id FROM metric_snapshots WHERE published_post_id=p.id ORDER BY observed_at DESC LIMIT 1) LEFT JOIN performance_refresh_state s ON s.published_post_id=p.id WHERE a.owner_id=? ORDER BY p.published_at DESC LIMIT 5",
  )
    .bind(owner)
    .all<{
      id: string;
      actual_text: string;
      published_at: string;
      metrics_json: string | null;
      observed_at: string | null;
      attempted_at: string | null;
      refresh_status: string | null;
    }>();
  return {
    automatic_refresh:
      "hourly; up to 5 linked posts from the last 30 days per run",
    configured: !!(
      env.ZERNIO_API_KEY &&
      env.ZERNIO_ACCOUNT_ID &&
      env.X_USERNAME
    ),
    recent_posts: rows.results.map((r) => ({
      post_id: r.id,
      text: r.actual_text,
      published_at: r.published_at,
      metrics: r.metrics_json ? JSON.parse(r.metrics_json) : null,
      observed_at: r.observed_at,
      last_refresh_attempt: r.attempted_at,
      refresh_status: r.refresh_status,
    })),
    interpretation:
      "Individual outcomes are descriptive. Compare similar topics and equal observation ages before inferring patterns; no causal or reach claims.",
  };
}
