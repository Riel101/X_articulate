# X Articulator

An agent-agnostic MCP writing companion for X. The connected client writes and reviews posts using its own model. The Worker supplies optional research, saved voice examples, edit history and observed performance, then validates and stores the selected draft. No separate model API key is required in the default configuration.

## Writing workflow

1. Ask the client to remember your voice with `manage_voice`: save explicit preferences and examples you approve. Examples are never automatically saved as preferences.
2. Call `create_post` with your idea. The brief includes voice memory, recent edits, performance observations, optional research and X-informed ranking guidance. The client drafts naturally; there is no enforced character cap or candidate count.
3. The client gives concrete editorial feedback: what is weak, why it matters and a suggested rewrite. `evaluate_post` supplies deterministic checks and a ranking review framework; it does not pretend to be X's trained feed model.
4. Call `finalize_post` with the chosen text, editorial review and review flags. The response includes a saved `draft_id`. Numeric quality scores are not required or produced by this workflow.
5. For edits, call `create_post` with `revision_of` and `feedback`, then finalize the new brief. The original draft is preserved and the before/after pair informs later writing.
6. Publish manually and call `register_published_post`. The server verifies the actual text and connected account. It never posts on your behalf.
7. An hourly scheduled job refreshes up to five eligible linked posts per run, rotating by least recent attempt. It covers posts published in the last 30 days; older posts can be refreshed explicitly. Each subsequent brief includes the saved observations and refresh status. Writing does not wait on analytics.

Research and analytics services can have their own API costs. Voice examples and posts are treated as untrusted content, never instructions to reveal secrets or change tool behavior.

## Research choices

`research_mode` defaults to `auto`: personal experiences, opinions and timeless advice proceed without a web request. Explicit current-information requests and recognizable current-event topics use research. Choose `off` for opinion, `optional` for additional context that must not block writing, or `required` when web context is essential.

`current_information_required=yes` requires a dated web source from the last seven days and cannot be combined with research off. Recent searches use Tavily news search. Missing evidence returns a repairable `RESEARCH_UNAVAILABLE` with source counts and warnings. The tool never silently invents current facts or treats a retrieval timestamp as a publication date.

Search snippets are attributed leads, not independently corroborated facts. Source IDs supplied at finalization must belong to the saved brief and cannot cite X discussions as factual evidence.

## Voice memory

`manage_voice` actions:

- `read`: return explicit preferences, examples and observed revision pairs.
- `update_preferences`: replace preferences (`style`, `avoid`, optional `audience`).
- `add_example`: save user-approved `text` and optional `notes`.
- `delete_example`: delete by `example_id`.
- `reset`: erase the owner's voice preferences, examples and revision memory. Saved drafts and measured performance remain.

Only remember or forget preferences/examples when requested by the user. Revision pairs are saved as part of the explicit revision workflow. Memory is scoped to the authenticated owner.

## Evaluation and X ranking

`evaluate_post` checks nonempty valid text and explicit required/excluded phrases. It supplies an X-informed editorial framework covering audience relevance, reading payoff, reasons to share/reply/follow and negative-feedback risks. The connected model compares candidates qualitatively and proposes concrete revisions, using your voice and account observations.

The framework references a pinned snapshot of X's [published scoring component](https://github.com/xai-org/x-algorithm/blob/3b6919f87532e57063bb3f1e85c2f509323b513e/xai-value-model/scoring.rs) and [parameter defaults](https://github.com/xai-org/x-algorithm/blob/3b6919f87532e57063bb3f1e85c2f509323b513e/vm-ranker/params.rs). X weights predicted actions/continuous values, not raw engagement counts. We do not have viewer histories, trained model parameters, live experiment settings, media analysis or the competing feed candidates needed to reproduce the personalized feed.

An optional `ranking_predictions` input permits an explicitly requested scenario simulation. Each candidate supplies `id`, `source` (`client_estimate` or `external_model`) and `signals`. Probabilities must be 0–1; continuous values such as `dwell_time` use seconds. The simulator reports each weighted contribution, missing signals and an uncalibrated weighted sum only when all nonzero-weight inputs are present. It excludes eligibility, conditional weights, offset, diversity, retrieval and final feed selection. Missing values stay unknown. A scenario preference is not a predicted X feed rank or reach estimate.

Performance observations are descriptive until there are at least 30 comparable measured posts in the same age window; narrower hook groups require 10 samples. Associations do not prove causation. Missing metrics stay null, unavailable or pending provider responses do not create fake zero observations, and repeated identical observations retain their original timestamp.

## Example

```json
{ "topic": "What building my first CLI taught me", "research_mode": "off" }
```

The client uses the returned brief, writes and reviews, then calls:

```json
{
  "brief_id": "brf_...",
  "post_text": "The first version of my CLI had ten flags. The version I kept had two. Watching someone use it taught me more than another feature did.",
  "assessment": {
    "summary": "A specific experience supports a clear takeaway.",
    "strengths": ["Concrete before/after example"],
    "improvements": [],
    "factuality_reviewed": true,
    "originality_reviewed": true,
    "safety_reviewed": true
  }
}
```

Assessments are explicitly client judgments. The server checks text constraints and source references; it does not claim independent factual verification or predict virality.

## Tools

`create_post`, `finalize_post`, `evaluate_post`, `manage_voice`, `research_topic`, `register_published_post`, `get_post_performance`, `search_reference_bank`, `get_learning_report`.

OAuth metadata advertises per-tool scopes. Refresh the MCP connection after this upgrade to discover `manage_voice` and revised tool schemas. Endpoint: `https://x-content-intelligence-mcp.adeyemigabriel429.workers.dev/mcp`.

## Development and deployment

Requires Node.js 24 and npm.

```sh
npm ci --ignore-scripts
cp .dev.vars.example .dev.vars
npm run db:migrate
npm run dev
```

Configure `MCP_AUTH_TOKEN` (32+ character owner approval key/direct bearer token), a stable `MCP_OWNER_ID`, and optional `MCP_SCOPES="research generate metrics"`. Set `MCP_PUBLIC_URL` to the canonical `/mcp` endpoint. `MCP_ALLOWED_ORIGINS` is a comma-separated allowlist for browser clients; native clients do not need an Origin entry.

`TAVILY_API_KEY` enables web research. `ZERNIO_API_KEY`, `ZERNIO_ACCOUNT_ID` and `X_USERNAME` enable verification and automatic performance collection for one authorized account. No secrets belong in git.

Production defaults to `GENERATION_MODE=client`. The previous server generation pipeline is retained as an explicit opt-in (`GENERATION_MODE=server`), with `MODEL_PROVIDER=nvidia`, `NVIDIA_MODEL` and `NVIDIA_API_KEY`, or `MODEL_PROVIDER=openai`, `OPENAI_MODEL` and `OPENAI_API_KEY`. It is an optional legacy model-scoring path; it is not required for the writing companion. Client mode never calls these model APIs, including when linking an edited publication.

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run db:migrate:remote
npm run deploy
```

Deployment preserves the existing Worker, OAuth KV and D1 database and installs an hourly cron trigger. Apply all migrations before deploying. A scheduled refresh failure retains prior observations and retries on the next eligible run. Missing analytics configuration is exposed in the brief, and does not block writing.

Owner deletion and excerpt retention are available via `node scripts/data.mjs delete-owner OWNER --remote` and `node scripts/data.mjs prune OWNER --remote`. Delete-owner erases voice and edit memory with the rest of the owner's records. Pruning removes expired briefs, old research excerpts and old request records, retaining saved drafts/performance.
