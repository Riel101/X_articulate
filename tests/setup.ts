import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach } from "vitest";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import type { Env as AppEnv } from "../src/config/env";
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Cloudflare {
    interface Env extends AppEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.batch(
    [
      "accounts",
      "drafts",
      "learning_summaries",
      "usage_events",
      "request_locks",
    ].map((table) => env.DB.prepare(`DELETE FROM ${table}`)),
  );
});
