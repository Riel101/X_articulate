import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { BankRepository } from "../src/repositories/bank";
import { normalizeMetrics } from "../src/domain/post";
it("requires 30 unique measured posts in the same cohort and observation window", async () => {
  const bank = new BankRepository(env, "owner_test");
  const account = await bank.account();
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO drafts(id,owner_id,topic,audience,tone,intent,language,final_text,text_hash,features_json,created_at,status,input_hash,response_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      "draft_seed",
      "owner_test",
      "agents",
      "developers",
      "clear",
      "educate",
      "en",
      "Original",
      "hash",
      "{}",
      now,
      "published",
      "input",
      "{}",
    )
    .run();
  async function seed(n: number, age = 48) {
    const post = `pub_${n}`;
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO published_posts(id,draft_id,account_id,x_post_id,x_post_url,actual_text,actual_text_hash,features_json,published_at,edited_from_draft,verification,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      ).bind(
        post,
        "draft_seed",
        account.id,
        String(100000 + n),
        "https://x.com/test/status/" + (100000 + n),
        "Actual?",
        "hash",
        JSON.stringify({ hook: "question", format: "single" }),
        now,
        0,
        "verified",
        now,
      ),
      env.DB.prepare(
        "INSERT INTO metric_snapshots VALUES(?,?,?,?,?,?,?,?,?)",
      ).bind(
        `snap_${n}`,
        post,
        "zernio",
        now,
        now,
        JSON.stringify(
          normalizeMetrics({
            impressions: 1000,
            likes: n,
            comments: 2,
            shares: 3,
            quotes: 1,
          }),
        ),
        "[]",
        age,
        `key_${n}`,
      ),
    ]);
  }
  for (let n = 0; n < 29; n++) await seed(n);
  expect(await bank.insights("agents", "developers")).toMatchObject({
    sample_size: 29,
    learning_status: "insufficient_data",
    patterns: [],
  });
  await seed(29);
  const ready = await bank.insights("agents", "developers");
  expect(ready).toMatchObject({ sample_size: 30, learning_status: "usable" });
  expect(ready.patterns[0]).toMatchObject({
    hook: "question",
    sample_size: 30,
    association_only: true,
  });
  await seed(30, 240);
  expect((await bank.insights("agents", "developers")).sample_size).toBe(30);
  expect((await bank.insights("other topic", "developers")).sample_size).toBe(
    0,
  );
  expect((await bank.insights("agents", "other audience")).sample_size).toBe(0);
  expect((await bank.insights("agents", "developers", 5, 24)).sample_size).toBe(
    0,
  );
  expect((await bank.insights("agents", undefined)).sample_size).toBe(0);
  await bank.refresh("agents", "developers");
  const stored = await env.DB.prepare(
    "SELECT sample_size,stale FROM learning_summaries WHERE owner_id=?",
  )
    .bind("owner_test")
    .first();
  expect(stored).toMatchObject({ sample_size: 30, stale: 0 });
});
