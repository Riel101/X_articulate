# X Content Intelligence MCP

A private, authenticated remote MCP server for researching and writing original X posts, then learning from the performance of posts you manually publish. Built with TypeScript, Cloudflare Workers, D1, KV, the official MCP SDK and Cloudflare Agents. [BUILD.md](BUILD.md) is the product blueprint.

## What it does

- `create_post`: topic → attributed research → four distinct candidates → heuristic evaluation → up to two repairs → one separately copyable post, analytics and saved draft ID.
- `research_topic`: inspect normalized Tavily web and Zernio recent X search results.
- `evaluate_post`: compare up to four candidates using the same versioned rubric and hard gates.
- `register_published_post`: verify a manually published post against the configured connected X account and save its actual text.
- `get_post_performance`: fetch authorized metrics, save a deduplicated snapshot, refresh learning summaries, then return observed performance.
- `search_reference_bank` and `get_learning_report`: account-scoped comparisons using one observation per post in the same age window.

Posts use X's weighted character rules, including shortened URLs and emoji. Missing metrics stay `null`; pending sync never creates a zero observation. Historical associations require 30 comparable measured posts, and only break quality-score ties within two points. Scores are heuristic assessments, never predictions of virality. There is no posting, scheduling, reply or engagement tool.

## Local setup

Requires Node.js 24 and npm.

```sh
npm ci --ignore-scripts
cp .dev.vars.example .dev.vars
npm run db:migrate
npm run dev
```

Fill in `.dev.vars` locally. Never commit real credentials.

| Setting             | Purpose                                                       |
| ------------------- | ------------------------------------------------------------- |
| `MCP_AUTH_TOKEN`    | Random bearer token of at least 32 characters                 |
| `MCP_OWNER_ID`      | Stable owner ID; storage identity comes from this binding     |
| `MCP_SCOPES`        | Space-separated `research generate metrics` permissions       |
| `OPENAI_API_KEY`    | OpenAI Responses API credential                               |
| `OPENAI_MODEL`      | Structured-output-capable model; configurable in Wrangler     |
| `TAVILY_API_KEY`    | Web research; optional for evergreen-only development         |
| `ZERNIO_API_KEY`    | Recent X search, owned publication verification and analytics |
| `ZERNIO_ACCOUNT_ID` | One connected and authorized X account                        |
| `X_USERNAME`        | That account's X username                                     |
| `DAILY_TOOL_LIMIT`  | Atomic daily per-owner tool-call cap; default 100             |

If no research provider is available, evergreen topics can still produce timeless advice. Current-information requests fail when research is unavailable. Search excerpts are treated as untrusted leads and are never automatically labeled corroborated. Factuality and originality gates are model assessments, with that limitation included in the response.

`GET /health` is a public liveness endpoint. The MCP endpoint is `http://localhost:8787/mcp` (check Wrangler's output for the actual port). Every MCP request requires `Authorization: Bearer <token>`.

This release uses the blueprint's **private first-party bearer-token mode**. Use clients that support custom HTTP headers. OAuth discovery, login and dynamic client registration are not implemented; clients requiring OAuth cannot connect until an OAuth layer is added. Each deployment maps one token to one owner/account. Changing an existing account mapping is deliberately rejected.

## Connect an MCP client

For a Streamable HTTP client that accepts this configuration shape:

```json
{
  "mcpServers": {
    "x-content": {
      "type": "http",
      "url": "http://localhost:8787/mcp",
      "headers": { "Authorization": "Bearer YOUR_PRIVATE_TOKEN" }
    }
  }
}
```

Client config formats vary; keep the bearer token in that client's secure environment/secret store. The endpoint supports MCP initialization, discovery, structured results and tool errors.

Example tool arguments:

```json
{
  "topic": "Why AI agents fail in production",
  "audience": "software developers",
  "idempotency_key": "agents-001"
}
```

Save the returned `draft_id`. Publish the `post_text` yourself, then call:

```json
{
  "draft_id": "drf_...",
  "x_post_url_or_id": "https://x.com/yourname/status/1234567890123456789"
}
```

Call `get_post_performance` with the returned `published_post_id`. `refresh: false` reads the last stored observation; `true` fetches and learns. Zernio must be able to sync that externally published post for the connected account. If a native X ID cannot be looked up directly, analytics resolves it from up to two account-scoped pages for its publication date; posts beyond that bounded lookup return unavailable. Its analytics add-on, platform permissions, sync delays, availability and charges apply. Provider content takes precedence over user-reported text/time. Edited text receives its own heuristic evaluation; original draft scores are not attributed to it. Posts that cannot be verified are not admitted to the outcome bank.

## Checks

```sh
npm run typecheck
npm run lint
npm test
npm run build
```

Tests run in the Cloudflare Worker runtime with real local D1 migrations and mocked provider HTTP responses. They do not spend API credits. The dry-run build emits the Worker bundle into ignored `dist/`. Live provider acceptance and host-client checks require configured credentials; mocked tests cannot establish real account permissions or model quality.

## Cloudflare deployment

```sh
npx wrangler login
npx wrangler d1 create x-content-bank
npx wrangler kv namespace create RESEARCH_CACHE
```

Replace the placeholder D1 and KV IDs in `wrangler.jsonc` with the returned IDs. Add non-secret owner/account settings through Worker bindings or Wrangler variables. Store credentials with `wrangler secret put`:

```sh
npx wrangler secret put MCP_AUTH_TOKEN
npx wrangler secret put MCP_OWNER_ID
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put TAVILY_API_KEY
npx wrangler secret put ZERNIO_API_KEY
npx wrangler secret put ZERNIO_ACCOUNT_ID
npx wrangler secret put X_USERNAME
npm run db:migrate:remote
npm run deploy
```

Connect clients to `https://<worker>.<subdomain>.workers.dev/mcp`. Custom domains may require the Agents handler's allowed-hostname configuration. Browser requests are restricted to the same origin. The repository contains no production credentials, provisioned resources or automatic deployment step.

## Budgets and operations

Generation is bounded to one research query per configured provider, four candidates, one batch evaluation and up to two revision/evaluation pairs. Each OpenAI response has a 2,200-output-token cap and 30-second deadline. Provider requests have short timeouts, bounded response sizes, and one retry for safe reads; model calls and external sync writes are not retried automatically. D1 locks prevent concurrent idempotency-key runs. A lock expires after four minutes following a crash. Reusing a key for different input is rejected.

Tool usage is reserved atomically before provider work. D1 stores request ID, tool, status and duration without source payloads or secrets in logs. `cost_units` remains nullable: no invented dollar/token accounting. Configure actual spend limits/alerts in OpenAI, Tavily, Zernio and Cloudflare accounts. The application quota caps calls, not dollars. Monitor Worker request logs and `usage_events` for latency/failures; p50/p95 and live model calibration require actual traffic.

Reference-bank searches default an omitted audience to `general readers`. The reference bank uses exact normalized topic and audience matches, the same connected account, single-post format, and observations within ±25% of the selected age window. It selects one snapshot closest to the window per post. It excludes incomplete interaction rates and needs 30 posts per cohort. It reports medians and smoothed descriptive hook associations; it does not train or activate a predictive model. Generation queries current D1 observations rather than trusting a potentially stale cached summary. New snapshot persistence survives a summary-refresh failure; the summary is marked stale.

## Data retention and deletion

D1 is authoritative; public research cache entries expire after 15 minutes for current topics or 24 hours for evergreen topics. Account metrics are never cached in shared KV. Drafts, actual published text and snapshots remain until the owner requests deletion. Research snippets have a 30-day retention target and usage records 90 days. Run the maintenance command regularly:

```sh
node scripts/data.mjs prune owner_local --local
# Use --remote for production, with the correct owner ID.
```

To fulfill an authorized owner's deletion request, run:

```sh
node scripts/data.mjs delete-owner owner_local --local
```

Deletion cascades through publications, snapshots, evaluations and source references. Rotate/revoke the owner's token afterward to prevent fresh writes. Shared public research cache expires independently and contains no owner token or private analytics. Cloudflare backups/log retention must be managed separately. Rotate provider secrets using `wrangler secret put`, revoke old keys at their providers, and rotate the MCP client token together with the Worker binding.

## Extend research

Implement `ResearchProvider` in `src/providers/research.ts` (`id`, `supports`, `search`) and pass it to `ResearchOrchestrator` or register it in `defaultProviders`. Return normalized provenance, short permitted excerpts and honest verification state. Providers must enforce account permissions, deadlines, retries, response limits and applicable data-use terms. External content is untrusted data; no adapter should execute source instructions or expose arbitrary URL fetching.

Provider contracts were checked against the [Cloudflare stateless MCP handler](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/), [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [Tavily Search](https://docs.tavily.com/documentation/api-reference/endpoint/search), [Zernio X search changelog](https://docs.zernio.com/changelog), [external-post sync](https://docs.zernio.com/analytics/sync-external-posts) and [analytics](https://docs.zernio.com/core/analytics). Provider permissions and response shapes still require live acceptance with your own account.
