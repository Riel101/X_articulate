import { execFileSync } from "node:child_process";
const [action, owner, target] = process.argv.slice(2);
if (
  !["delete-owner", "prune"].includes(action) ||
  !/^[a-zA-Z0-9_-]{1,100}$/.test(owner ?? "") ||
  !["--local", "--remote"].includes(target)
) {
  console.error(
    "Usage: node scripts/data.mjs <delete-owner|prune> <owner_id> <--local|--remote>",
  );
  process.exit(1);
}
// Owner IDs are restricted above; never interpolate arbitrary SQL or credentials.
const sql =
  action === "delete-owner"
    ? `DELETE FROM voice_profiles WHERE owner_id='${owner}'; DELETE FROM voice_examples WHERE owner_id='${owner}'; DELETE FROM draft_revisions WHERE owner_id='${owner}'; DELETE FROM drafting_briefs WHERE owner_id='${owner}'; DELETE FROM accounts WHERE owner_id='${owner}'; DELETE FROM drafts WHERE owner_id='${owner}'; DELETE FROM learning_summaries WHERE owner_id='${owner}'; DELETE FROM usage_events WHERE owner_id='${owner}'; DELETE FROM request_locks WHERE owner_id='${owner}';`
    : `DELETE FROM drafting_briefs WHERE owner_id='${owner}' AND expires_at < strftime('%Y-%m-%dT%H:%M:%fZ','now'); DELETE FROM research_sources WHERE retrieved_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days') AND draft_id IN (SELECT id FROM drafts WHERE owner_id='${owner}'); UPDATE drafts SET response_json=json_set(response_json,'$.research.sources',json('[]'),'$.research.warnings',json('["Research excerpts removed under retention policy."]')) WHERE owner_id='${owner}' AND created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days'); DELETE FROM usage_events WHERE owner_id='${owner}' AND created_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-90 days'); DELETE FROM request_locks WHERE owner_id='${owner}' AND expires_at < strftime('%Y-%m-%dT%H:%M:%fZ','now');`;
execFileSync(
  "npx",
  [
    "--no-install",
    "wrangler",
    "d1",
    "execute",
    "x-content-bank",
    target,
    "--command",
    `PRAGMA foreign_keys=ON; ${sql}`,
  ],
  { stdio: "inherit" },
);
