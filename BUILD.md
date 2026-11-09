# BUILD.md — X Content Intelligence MCP Server

**Implementation update — client generation (2026-11-09):** The default is now `GENERATION_MODE=client`. `create_post` persists research/preferences and returns a drafting brief. The MCP host writes, assesses and revises with its own model, then calls `finalize_post` for deterministic validation and durable storage. `evaluate_post` performs deterministic checks only in this mode; client scores are explicitly labelled, and edited publication linking makes no model call. No server OpenAI key is required. The original one-call OpenAI workflow below remains available only with explicit `GENERATION_MODE=server`. Research, account ownership, observed-metrics learning, and OAuth remain server responsibilities.


**Status:** Implementation blueprint · **Revision:** 2.0 · **Updated:** 2026-11-08  
**Primary language:** TypeScript · **Runtime:** Cloudflare Workers · **Protocol:** Remote MCP (Streamable HTTP)  
**Core workflow:** Topic → research → reference-bank insights → draft generation → evaluation → refinement → copy-ready X post + transparent analytics  
**Learning loop:** Manually published post → linked X post ID → on-demand analytics retrieval → persisted reference-bank update → better future draft selection

> **Product promise:** Give any authorized MCP-compatible agent a topic and receive one original, copy-ready X post with useful pre-publication analysis. When a published post's performance is requested, store its observed metrics and use the accumulated evidence to improve later recommendations. **Do not claim to predict or guarantee virality.**

---

## 1. Product scope and decisions

### 1.1 User stories

**Generate a post:**

> “Write an X post about why AI agents fail in production.”

The host agent calls `create_post` with the topic (and optional preferences). The MCP server researches the topic, looks up relevant historical performance patterns, creates multiple original drafts, evaluates them, refines the best one, and returns **one post to copy**, plus its pre-publication assessment and sources.

**Record a published post:**

> “I published that post: https://x.com/example/status/1234567890123456789.”

The host calls `register_published_post` to associate the published X post with the previously generated draft. It records any edits made after generation, so performance is not incorrectly attributed to the original draft.

**Check performance and improve future posts:**

> “How did that post perform?”

The host calls `get_post_performance`. The server requests permitted metrics from Zernio, stores a timestamped observation in the reference bank, computes clearly defined derived rates and cohort comparisons when possible, and returns the results. Later generations can use the newly observed outcomes.

### 1.2 Required capabilities

- Any **authorized** MCP-compatible client can discover and use the tools.
- A topic alone is sufficient for a first draft; preferences are optional.
- Research uses **Zernio for recent X posts** and **Tavily for web research**, with a provider registry that permits additional research sources.
- The **reference bank** stores generated/published content, context, versions, and actual performance snapshots. Its own historical posts are the primary learning dataset.
- Retrieving performance **updates the bank in the same logical operation**; duplicate calls do not create duplicate observations.
- Future posts use reference-bank evidence when enough comparable data exists; the system works with an empty bank.
- The final response separates **heuristic pre-publication scores** from **observed post-publication metrics**.
- A user can copy the final post without manually removing analytics or citations.

### 1.3 Non-goals (initial release)

- Autonomous posting, scheduling, or engagement automation. The user copies and publishes manually.
- Guaranteed virality, reverse-engineering private X ranking decisions, or inventing impression forecasts.
- Scraping X outside permitted interfaces, copying other creators' posts verbatim, or manufacturing engagement.
- Training a large language model from scratch or automatically rewriting application code after each result.
- A full analytics dashboard, paid multi-tenant SaaS, or large-scale batch analytics ingestion in the first release.

### 1.4 Explicit product choices

| Area | Selected technology | Reason |
|---|---|---|
| Language | **TypeScript** (`strict: true`) | Shared typed contracts, suitable for Workers and MCP |
| Runtime | **Cloudflare Workers** | Remote HTTP execution and bindings to persistent services |
| MCP | **Official TypeScript MCP SDK + Cloudflare Agents SDK `createMcpHandler`** | Stateless Streamable HTTP MCP server |
| Validation | **Zod** | Runtime validation and typed tool schemas |
| Database / reference bank | **Cloudflare D1 (SQLite)** | Durable, queryable posts, scores, sources, and metric snapshots |
| Research cache | **Cloudflare KV** | Short-lived provider response cache; never the source of truth |
| X research + analytics | **Zernio API** | Recent X search, post lookup and authorized post analytics |
| Web research | **Tavily Search API** | Search results and source URLs for factual verification |
| Content generation/evaluation | **OpenAI Responses API**, model configured by environment | Structured generation, revision, and rubric evaluation |
| Database access | **Typed repository layer + D1 prepared statements + SQL migrations** | Minimal runtime overhead, explicit queries and migrations |
| Tests | **Vitest + Cloudflare Workers test integration** | Unit, integration, and Worker-runtime tests |
| Developer tooling | **Wrangler, ESLint, Prettier, TypeScript** | Local development, type checking, formatting and releases |

**Deliberately deferred:** Vectorize/embeddings, Queues, scheduled analytics refresh, heavy ML training, and a separate orchestration framework. Add them only when measured needs justify the complexity. These are choices for the project, not hard dependencies of the MCP protocol.

---

## 2. Architecture and boundaries

```text
USER: "Write about <topic>"
          |
          v
ANY AUTHORIZED MCP HOST (Claude / ChatGPT / LangGraph / custom)
          | Streamable HTTP + authentication
          v
CLOUDFLARE WORKER — MCP ENTRYPOINT (/mcp)
          |
          +-- Tool schemas / auth / quotas / request correlation
          |
          +-- create_post (one-call workflow for simple clients)
          |     |
          |     +-- ResearchOrchestrator
          |     |     +-- Zernio X search adapter
          |     |     +-- Tavily web search adapter
          |     |     +-- Other ResearchProvider adapters (future)
          |     |     +-- KV research cache
          |     |
          |     +-- ReferenceBankRepository <------ D1
          |     |     (comparable historical posts / patterns)
          |     |
          |     +-- GenerationService ----------- OpenAI API
          |     +-- EvaluationService ---------- rubric + evidence
          |     +-- RevisionService ------------ OpenAI API
          |     +-- FinalValidator ------------- weighted X length, facts, rules
          |     +-- DraftRepository ------------> D1
          |     |
          |     +-- FinalPost + PrePublicationAnalytics
          |
          +-- register_published_post ----------> D1 link to X ID
          |
          +-- get_post_performance
          |     +-- Zernio analytics adapter ----> X observed metrics
          |     +-- Normalize / dedupe / persist -> D1 metric snapshots
          |     +-- Update learning summaries ---> D1
          |     +-- Return observed analytics
          |
          +-- get_learning_report -------------> D1 cohort summaries

NO AUTOMATIC PUBLISHING. A draft is not an observed success until linked
with an actual published post and a valid metrics observation.
```

### 2.1 Responsibilities

**MCP host agent** — receives the topic, invokes `create_post`, displays the final text separately from analytics, and invokes the publication/performance tools on later user requests. It does not need to implement the content-generation pipeline.

**MCP server** — owns tool contracts, input validation, provider access, the reference bank, generation/evaluation orchestration, persistence, and honest analytics. This makes behavior consistent across different agents.

**External adapters** — translate Zernio, Tavily, and other providers into stable internal models. No business logic should depend directly on a provider's response JSON.

**D1** — authoritative source for generated drafts, publication links, observations, score versions, and learning summaries. **KV** is an optional cache only; cache loss must not corrupt the bank.

### 2.2 Stateless execution

Use Cloudflare's **stateless `createMcpHandler`**: construct a fresh MCP server for each HTTP request. Do not rely on in-memory session state or a process that stays alive. Persist durable state in D1; use request IDs and idempotency keys to resume safely. A Durable Object is **not** required for this design.

The public remote endpoint is `/mcp`, exposed through the Worker URL or a custom domain. Protect it before enabling billable API calls.

---

## 3. Research subsystem: Zernio, Tavily, and extensible providers

### 3.1 Provider contract

```ts
type ResearchKind = "x_post" | "web" | "official" | "news";

type ResearchEvidence = {
  id: string;
  kind: ResearchKind;
  provider: string;
  title?: string;
  url: string;
  excerpt: string;            // short, permitted excerpt; not a page dump
  author?: string;
  publishedAt?: string;       // ISO-8601 if available
  retrievedAt: string;
  claims: string[];           // facts/insights supported by this source
  verification: "corroborated" | "single_source" | "unverified";
};

interface ResearchProvider {
  id: string;
  supports(kind: ResearchKind): boolean;
  search(query: string, opts: ResearchOptions): Promise<ResearchEvidence[]>;
}
```

Register providers by capability, not by hardcoded conditionals throughout the workflow. Each adapter implements timeout, retry, rate-limit, normalization, and provider-specific permissions. ResearchOrchestrator deduplicates URLs/post IDs and selects useful evidence under a fixed budget.

### 3.2 Zernio — X post discovery and metrics

- Use Zernio's documented **`GET /v1/twitter/search`** to search recent public X posts (documented seven-day search window), subject to the connected account, permissions, provider availability, and API charges.
- Use X search to discover **current conversations, competing angles, terminology, and audience interests**, not to assert that a retrieved post is viral.
- Normalize results to `ResearchEvidence`; retain X post ID, author, URL, publication time, and only the metrics the API actually returns.
- Use **`GET /v1/analytics`** for authorized post analytics. A post may have pending sync (`202`), missing fields, or a provider failure; handle each explicitly.
- Zernio may support externally published posts through its analytics/sync features, but **verify account eligibility and the exact supported flow** before assuming any arbitrary X post can be analyzed.
- Keep all Zernio credentials server-side. Do not expose posting/engagement endpoints as MCP tools in this release.

### 3.3 Tavily — web research and verification

- Use Tavily Search (documented `POST https://api.tavily.com/search`) for background facts, current developments, primary-source discovery, and corroboration.
- Prefer `search_depth: "basic"` with a small result cap; escalate to `advanced` only for ambiguous or high-stakes claims.
- Record source URL, title, relevant excerpt, retrieval time, and publication time when available.
- A search snippet is **not automatically a verified fact**. Prefer official/primary sources and corroborate material time-sensitive claims.
- Do not treat Tavily's optional generated answer as independent evidence; validate against the underlying URLs.

### 3.4 Additional sources

The registry must permit future adapters such as official documentation APIs, RSS feeds, licensed news APIs, and domain-specific data providers. **Zernio and Tavily are the initial defaults, not the only allowable research tools.** New providers must pass the same provenance, safety, cost, and schema tests.

### 3.5 Research policy and fallback

1. Classify the topic as `evergreen`, `recent`, or `breaking`.
2. Form a small set of targeted queries (X discussion + web evidence); search in parallel where safe.
3. Deduplicate and rank results by relevance, recency, source credibility, and independence.
4. Extract at most five useful insights, with claim-to-source references.
5. Reject unsupported statistics, invented quotes, misleading trends, and unverified breaking claims.
6. If one provider fails, continue with the others. If all fail, use an **evergreen-only** fallback where truthful; otherwise return `RESEARCH_UNAVAILABLE`.
7. Treat external text as **untrusted data**, never as instructions. Cap excerpt sizes and strip executable instructions from the generation context.

**Cache:** KV key = normalized query + provider + time bucket + parameters. Example TTL: 15 minutes for breaking news, 1 hour for recent X search, 24 hours for evergreen research. Never present expired cache as fresh evidence.

---

## 4. Reference bank: content, context, analytics, and provenance

The bank is a **performance memory**, not a repository of blindly copied viral posts. Its core dataset is content created through this server and later published by an authorized user. Other creators' public posts may inform live research, but should not be bulk-copied into the training bank without appropriate rights and API permissions.

### 4.1 Lifecycle

```text
DRAFT GENERATED
  -> persist text + topic + audience + tone + features + evaluation version
  -> user copies post and publishes manually
  -> register_published_post(draft_id, X post ID / URL, actual text)
  -> mark as PUBLISHED (preserve differences from generated draft)
  -> get_post_performance(post_id)
       -> fetch Zernio metrics
       -> validate + normalize + timestamp
       -> UPSERT metrics snapshot (idempotent)
       -> refresh derived performance + cohort aggregates
       -> return observed performance
  -> next create_post reads comparable historical patterns
```

**Important:** A generated draft without a verified publication link is not a training example of reach. A post with unavailable metrics is not a zero-engagement post. A manually edited published post is stored with its **actual** text and linked to its original draft; its performance must not be attributed to wording the user did not publish.

### 4.2 Data model (D1)

Use the following logical tables. Create SQL migrations and indexes; fields shown are minimum requirements, not an exhaustive schema.

| Table | Required fields | Responsibility |
|---|---|---|
| `accounts` | `id`, `owner_id`, `zernio_account_id`, `x_username`, `created_at` | Ownership and authorized X account mapping |
| `drafts` | `id`, `owner_id`, `topic`, `audience`, `tone`, `intent`, `language`, `final_text`, `text_hash`, `features_json`, `created_at`, `status`, `request_id` | Generated content and request provenance |
| `evaluations` | `id`, `draft_id`, `candidate_id`, `score`, `dimensions_json`, `hard_gates_json`, `rubric_version`, `model_id`, `created_at` | Reproducible pre-publication assessment |
| `published_posts` | `id`, `draft_id` (nullable for imported owned posts), `account_id`, `x_post_id`, `x_post_url`, `actual_text`, `actual_text_hash`, `published_at`, `edited_from_draft`, `created_at` | Authoritative publication link and actual published text |
| `metric_snapshots` | `id`, `published_post_id`, `provider`, `provider_updated_at`, `observed_at`, `metrics_json`, `missing_fields_json`, `post_age_hours`, `ingestion_key` | Immutable-ish, deduplicated observed metric history |
| `research_sources` | `id`, `draft_id`, `provider`, `kind`, `source_url`, `claim`, `verification`, `retrieved_at`, `published_at` | Factual provenance and citation tracing |
| `learning_summaries` | `id`, `owner_id`, `cohort_key`, `window_hours`, `sample_size`, `summary_json`, `algorithm_version`, `computed_at` | Cached historical patterns and comparisons |
| `usage_events` | `id`, `owner_id`, `request_id`, `tool_name`, `provider`, `status`, `duration_ms`, `cost_units`, `created_at` | Cost/latency observability without logging secrets |

**Indexes and constraints:**

- Unique `published_posts(account_id, x_post_id)`; one X post maps to one publication record per account.
- Unique `metric_snapshots(published_post_id, provider, ingestion_key)` for idempotent ingestion.
- Unique `drafts(owner_id, request_id)` where a client-supplied idempotency key is used.
- Index `drafts(owner_id, created_at)`, `published_posts(account_id, published_at)`, and `metric_snapshots(published_post_id, observed_at)`.
- Index/filter by normalized topic, audience, content format, and hook type; add full-text or vector search **later**, if ordinary indexed retrieval proves insufficient.
- Every read/write is scoped to the authenticated `owner_id`; never trust an owner ID supplied by a client.

**Storage rule:** Preserve metric snapshots rather than overwriting historical counts. Update a derived latest-metrics view/summary separately. Store provider-specific raw payloads only when necessary and permitted, with retention limits.

### 4.3 Features extracted from content

Store lightweight, versioned features for comparisons:

- Topic/category and intended audience.
- Hook style: question, contrarian, observation, narrative, utility, etc.
- Format: single post, length band, line breaks, links, media presence if known.
- Tone, reading complexity, call-to-action presence, claim count, source count.
- Generated versus actually published text; content feature extractor version.

These features are **descriptive**, not evidence that a style caused performance. Use them to retrieve comparable posts and test hypotheses over time.

### 4.4 Retrieval for generation

Given a new topic, fetch **up to 5–10 comparable owned published posts** using topic, audience, format, and performance window. Return a **pattern summary** (e.g., “practical tips outperform broad predictions in this account's 48-hour engagement rate”) rather than copying full historical text into the prompt by default.

If there are too few comparable observations, return `learning_status: "insufficient_data"` and do not invent a trend. Reference-bank insights are secondary to factual research and explicit user instructions.

---

## 5. Self-improvement engine: measured feedback, not magical prediction

### 5.1 Feedback trigger

**`get_post_performance` is a read-and-learn operation:** on every successful authorized metrics fetch, the server **persists the new observation first**, updates affected aggregates, and then returns the result. If the provider reports pending/unavailable data, do not fabricate or persist a zero result.

When the same snapshot is fetched twice, the ingestion key prevents duplicates. When new metrics arrive, append a new snapshot and recompute the relevant cohort summary. The tool response reports whether the bank was updated.

### 5.2 What to measure

For a post with known impressions:

```text
observed_interaction_rate =
  (likes + replies + reposts + quotes) / impressions
```

Only calculate the numerator when its included components are actually available; otherwise report a narrower, explicitly named rate or `null`. Never divide by zero. Keep `likes`, `replies`, `reposts`, `quotes`, `bookmarks`, `clicks`, `impressions`, and `views` distinct—provider fields are not interchangeable.

Also track post age when observed, topic, format, account, audience, and optional follower count (if legitimately available). Compare like with like: for example, **the same account, same observation-age window, and similar topic/format**. Avoid ranking a 3-hour post against a 30-day post using lifetime totals.

### 5.3 Learning strategy (three stages)

**Stage A — Cold start (0–29 comparable posts):** Use the fixed quality rubric and factuality gates. Save observations, but show `insufficient_data` instead of an evidence-based uplift claim. Do not change weights automatically.

**Stage B — Evidence-assisted (30+ valid, comparable observations):** Compute smoothed cohort baselines and descriptive associations by feature. Use them as **small, bounded tie-breakers** among drafts that already pass hard gates. Display cohort size, observation window, and whether evidence is sparse. The 30-post threshold is an engineering starting rule, not statistical proof.

**Stage C — Calibrated model (later, sufficient diverse history):** Train and validate a lightweight ranking/calibration model offline or in a suitable job environment. Store its version and evaluation metrics. Promote it only if it beats the fixed baseline on **held-out, time-separated** posts; keep rollback available. Do not train a model inside every MCP request.

### 5.4 Guardrails against misleading learning

- Do **not** optimize on a single viral outlier or update weights after every observation.
- Use smoothing, sample counts, and minimum cohort sizes; winsorize or robustly handle extreme outcomes where appropriate.
- Separate **correlation from causation**: a popular topic or account size may explain performance more than a hook.
- Avoid leakage: only data observed **before** a new post was generated may influence its prediction; store timestamps and model versions.
- Account for survivorship bias: keep weak posts and failures, not just winners.
- Respect data rights and X/Zernio terms. Do not assume search results include impressions for unrelated accounts.
- Do not expose unsupported “82% chance to go viral” claims. Any future predictive confidence requires measured calibration.
- Require explicit evaluation/approval to activate new scoring models; no self-modifying code or uncontrolled prompt changes.

### 5.5 Learning report

`get_learning_report` returns the number of published posts, number with usable metrics, current cohorts, comparison windows, recent aggregate changes, and the current scoring/calibration version. If the data is insufficient, say exactly why.

---

## 6. MCP tool contracts

Keep the public tool surface small. **`create_post` is the primary one-call tool** for arbitrary agents. Other tools support research inspection, historical insight, and later feedback. Expose structured output schemas and actionable errors for every tool.

### 6.1 `create_post` — primary tool

**Purpose:** Take a topic and return one original, copy-ready post with analytics. Internally orchestrates research, reference-bank lookup, generation, evaluation, revision, final validation, and persistence.

**Input**

```json
{
  "topic": "Why AI agents fail in production",
  "audience": "software developers",
  "tone": "clear, slightly witty",
  "intent": "educate",
  "language": "en",
  "post_length_profile": "standard",
  "must_include": [],
  "avoid": [],
  "current_information_required": "auto",
  "idempotency_key": "optional-client-generated-identifier"
}
```

Only `topic` is required. The server supplies sensible defaults. `post_length_profile: "standard"` uses X-aware weighted length validation (normally 280 for ordinary posts); do not assume JavaScript `string.length` equals X's weighted character count.

**Output (illustrative, not a real scored result)**

```json
{
  "draft_id": "drf_123",
  "ready_to_copy": true,
  "post_text": "Most AI agents don't fail because the model can't reason. They fail when tools break and nobody can explain why. Logs, permissions and retries aren't extras. They're the product.",
  "pre_publication_analytics": {
    "type": "heuristic_quality_assessment",
    "quality_score": 82,
    "scoring_version": "rubric-1.0",
    "dimension_scores": {
      "relevance": 18,
      "hook": 17,
      "clarity": 13,
      "value": 17,
      "shareability": 11,
      "discussion": 6
    },
    "weighted_characters": 169,
    "character_limit": 280,
    "strengths": ["Clear developer audience", "Specific practical insight"],
    "caveats": ["Quality score is not a virality probability"]
  },
  "research": {
    "status": "verified | evergreen_only | partial",
    "sources": [],
    "warnings": []
  },
  "learning": {
    "status": "insufficient_data",
    "comparable_post_count": 0,
    "scoring_adjustment_applied": false
  },
  "validation": { "length": "pass", "factuality": "pass", "constraints": "pass" }
}
```

`weighted_characters` above is illustrative; the implementation **must calculate it from the actual final text** rather than hardcode it.

### 6.2 `research_topic`

**Input:** `{ "topic": "string", "audience": "optional", "freshness": "auto | recent | evergreen", "max_insights": 5 }`  
**Output:** `{ "status": "verified | partial | evergreen_only | unavailable", "angles": [], "evidence": [ResearchEvidence], "warnings": [], "providers_used": [] }`

Use the provider registry. This tool must be useful independently of post generation and must not fabricate sources.

### 6.3 `search_reference_bank`

**Input:** `{ "topic": "string", "audience": "optional", "limit": 5, "window_hours": 48 }`  
**Output:** `{ "patterns": [], "examples": [{ "post_id": "...", "summary": "...", "metrics": {}, "observed_at": "..." }], "sample_size": 0, "learning_status": "insufficient_data | usable" }`

Restrict results to the authenticated owner's authorized dataset. Return full historical text only when permitted and explicitly useful; pattern summaries are the default. Do not conflate a heuristic score with an observed performance metric.

### 6.4 `evaluate_post`

**Input:** `{ "topic": "string", "candidates": [{ "id": "c1", "text": "..." }], "audience": "optional", "intent": "optional", "constraints": {} }`  
**Output:** `{ "rubric_version": "rubric-1.0", "ranked_candidates": [{ "id": "c1", "quality_score": 82, "dimensions": {}, "hard_gates": {}, "issues": [], "strengths": [] }], "recommended_id": "c1" }`

Batch candidates in one call. Always label scores as **heuristic**. Hard-gate failures cannot be overridden by high numerical scores. This is an advanced composability tool; `create_post` already uses the same internal evaluator.

### 6.5 `register_published_post`

**Input:** `{ "draft_id": "drf_123", "x_post_url_or_id": "https://x.com/.../status/...", "actual_published_text": "optional", "published_at": "optional ISO-8601" }`  
**Output:** `{ "published_post_id": "pub_123", "x_post_id": "...", "status": "linked", "edited_from_draft": false, "metrics_available": false }`

Validate the X ID/URL and ownership/account association. Where permitted, fetch the actual X post text and publication time for verification; otherwise mark the link as **user-reported** and require confirmation before using it for outcome learning. If the actual published text differs, store both texts and evaluate the actual version separately before using its features.

### 6.6 `get_post_performance` — feedback trigger

**Input:** `{ "published_post_id": "pub_123", "refresh": true }` (also allow an X URL/ID when it can be safely resolved to an authorized linked post).  
**Output:**

```json
{
  "status": "ok | pending | unavailable",
  "published_post_id": "pub_123",
  "source": "zernio",
  "observed_at": "2026-11-08T12:00:00Z",
  "post_age_hours": 48.2,
  "metrics": {
    "impressions": 4200,
    "likes": 110,
    "replies": 15,
    "reposts": 24,
    "quotes": null,
    "bookmarks": null
  },
  "missing_fields": ["quotes", "bookmarks"],
  "derived_rates": {
    "like_reply_repost_rate": 0.03548
  },
  "reference_bank": {
    "updated": true,
    "new_snapshot": true,
    "learning_summary_refreshed": true
  },
  "comparison": {
    "status": "insufficient_data",
    "sample_size": 0,
    "window_hours": 48
  }
}
```

Numbers are illustrative. The example rate includes **only** likes, replies, and reposts because quotes are missing. Never silently treat unavailable fields as zero. If Zernio returns `202` pending, respond with `status: "pending"` and a retry suggestion; **do not** store a zero-metric snapshot.

**Atomicity rule:** Normalize the provider response, then use a D1 transaction/batch where possible to persist the observation and update the affected derived state. If the aggregate refresh cannot complete, keep the valid snapshot and mark the summary stale for repair; never claim the update succeeded when it did not.

### 6.7 `get_learning_report`

**Input:** `{ "topic": "optional", "audience": "optional", "window_hours": 48 }`  
**Output:** `{ "total_published_posts": 0, "posts_with_usable_metrics": 0, "cohorts": [], "scoring_version": "rubric-1.0", "learning_status": "insufficient_data", "recommendations": [] }`

### 6.8 Internal services (not additional MCP tools)

```ts
interface ResearchOrchestrator { research(req: ResearchRequest): Promise<ResearchResult>; }
interface ReferenceBankRepository { findComparable(req: SimilarityQuery): Promise<BankInsights>; }
interface GenerationService { generate(req: GenerationRequest): Promise<Candidate[]>; }
interface EvaluationService { evaluate(req: EvaluationRequest): Promise<EvaluationResult>; }
interface RevisionService { revise(req: RevisionRequest): Promise<Candidate>; }
interface PostValidator { validate(req: FinalValidationRequest): ValidationResult; }
interface MetricsProvider { getPostMetrics(req: MetricsRequest): Promise<ProviderMetricsResult>; }
interface LearningService { refreshForPost(id: string): Promise<LearningUpdateResult>; }
```

Generation and revision remain internal to avoid exposing a dozen overlapping tools. They can be promoted to public MCP tools later if real client workflows need that flexibility.

---

## 7. Generation, scoring, and finalization

### 7.1 Default generation pipeline

```text
create_post(topic, preferences)
  1. Authenticate + authorize + validate input + enforce budget
  2. Load historical patterns from reference bank (if available)
  3. Research topic via Zernio + Tavily + eligible additional providers
  4. Construct grounded brief: topic, audience, insights, citations, patterns
  5. Generate four DISTINCT original candidates
  6. Score candidates in one batch; apply factuality/length/policy hard gates
  7. Select best valid candidate; revise at most twice if needed
  8. Re-evaluate final text after any revision
  9. Validate X weighted length and user constraints deterministically
 10. Save draft, scoring version, features, and source references to D1
 11. Return one copy-ready post + pre-publication analytics
```

Research and bank lookup may run concurrently. Keep LLM calls bounded. If all research fails on a breaking-news topic, do not invent a current-events post; explain the blocker. If the bank is empty, generate from researched context and the fixed rubric.

### 7.2 Scoring rubric (version `rubric-1.0`)

| Dimension | Max | Evaluation question |
|---|---:|---|
| Audience/topic relevance | 20 | Does it serve the intended reader and topic? |
| Hook and curiosity | 20 | Does the opening earn attention without deception? |
| Clarity and readability | 15 | Is it understandable, compact, and well structured? |
| Useful or novel value | 20 | Does it offer a real insight or takeaway? |
| Shareability | 15 | Would someone reasonably want to pass it on? |
| Conversation potential | 10 | Could it inspire a substantive response? |
| **Total** | **100** | **Quality rubric, not an X algorithm score** |

**Hard gates:** factual accuracy, user exclusions, no spam/manipulation, correct post length, safe content, and proper source handling. Never accept a high-scoring draft that fails a hard gate.

**Learning adjustment:** In Stage B, use a small, versioned, bounded adjustment or tie-breaker based on comparable observed outcomes; report whether applied. Do not silently change the meaning of the 0–100 rubric. Prefer showing `quality_score` and a separate `historical_fit` assessment rather than mixing incompatible quantities.

### 7.3 X compatibility

- Validate standard posts with X-compatible **weighted character counting** (URLs, Unicode, emojis, line breaks), using a tested implementation/configuration rather than `text.length`.
- Default to the standard 280-weighted-character profile unless the account and platform capabilities explicitly support something else.
- Never silently truncate; revise or return a repairable validation error.
- Preserve the exact final text for copying, including punctuation and line breaks.
- A revised candidate must be re-scored; old scores must not be attached to changed text.

### 7.4 Final user-facing presentation

```text
POST
Most AI agents don't fail because the model can't reason.
They fail when tools break and nobody can explain why.
Logs, permissions, and retries aren't extras. They're the product.

PRE-PUBLICATION ANALYTICS
Quality assessment: 82/100 (heuristic; example only)
Strengths: clear audience, useful takeaway, strong hook
Length: valid for standard X post
Research: evergreen / verified sources when relevant
Historical fit: insufficient data (0 comparable measured posts)
Draft ID: drf_123 (save this to link the published post later)

Note: This is not a forecast of impressions or virality.
```

The **post text must remain separately copyable**. Never append scoring notes, citations, or metadata to the post body unless the user explicitly asks for citations inside the post.

---

## 8. API integration and execution constraints

### 8.1 Remote MCP and authentication

- Serve **Streamable HTTP** at `/mcp`; use the Cloudflare Agents SDK's supported stateless MCP handler.
- Require authentication **before** allowing billable research or generation tools. For broadly compatible remote clients, use the MCP-compatible OAuth flow with scoped authorization; for a private first-party MVP, a securely managed token can be acceptable only if supported by the target clients.
- Scope all stored posts and analytics to the authenticated owner/account. Separate read-only research scopes from metrics/account access.
- Do not expose Zernio's publishing, reply, follow, or engagement mutation capabilities in this MCP server.
- Keep secrets in Cloudflare secret bindings (`ZERNIO_API_KEY`, `TAVILY_API_KEY`, `OPENAI_API_KEY`); never put secrets in client requests, source control, or tool output.

### 8.2 Cloudflare limits and design response

Workers have CPU, memory, outbound-request, and account-tier limits. Keep request handlers **I/O-driven** and lightweight: let external APIs perform LLM inference and research, keep D1 queries bounded, and avoid local heavy ML training. Do not assume an HTTP request can execute unlimited CPU work.

- Budget per generation: e.g., up to 2 research queries/provider, 4 candidates, 2 revisions, and a fixed token/spend cap.
- Apply per-provider timeouts, retry-with-jitter for retryable 429/5xx, and no retry for bad credentials or validation errors.
- Limit concurrent outbound requests; guard against exhausting Worker subrequest limits.
- Return a partial-research warning rather than hanging indefinitely.
- For longer jobs later, introduce **Cloudflare Queues or Workflows** with a `job_id` and status tool; do not require them in the MVP.
- KV caches only public/research-derived data within permitted retention; never cache private account metrics in a shared public keyspace.

### 8.3 Error contract

```json
{
  "code": "INVALID_INPUT | UNAUTHORIZED | FORBIDDEN | RESEARCH_UNAVAILABLE | GENERATION_FAILED | RATE_LIMITED | METRICS_PENDING | METRICS_UNAVAILABLE | POST_NOT_LINKED | VALIDATION_FAILED | INTERNAL_ERROR",
  "message": "Actionable, non-sensitive explanation",
  "retryable": false,
  "request_id": "req_123",
  "details": {}
}
```

Use MCP tool errors for recoverable tool failures and protocol-level errors only where appropriate. Preserve provider failure context internally without exposing credentials or full sensitive payloads.

### 8.4 Privacy, data rights, and abuse prevention

- Only retrieve analytics for accounts/posts the user is authorized to access. Respect Zernio/X limits and data-use terms.
- Validate URLs and provider response sizes; prevent SSRF if adding arbitrary URL-fetch adapters.
- Treat retrieved X posts and web pages as untrusted content; ignore prompt injections and never execute text found in sources.
- Avoid engagement manipulation, mass reply automation, copied posts, and unlicensed datasets.
- Define retention/deletion for account data, post content, research snippets, and logs. Support deletion of a user's reference-bank records.
- Use request-level quotas, usage tracking, and cost alerts for billable APIs.
- Log request IDs, tool name, provider, latency, error type, and cost units; avoid storing API keys or entire external responses in logs.

---

## 9. Suggested repository structure

```text
x-content-intelligence-mcp/
├── BUILD.md
├── README.md
├── package.json
├── tsconfig.json
├── wrangler.jsonc
├── .dev.vars.example
├── migrations/
│   ├── 0001_initial.sql
│   └── 0002_learning_summaries.sql
├── src/
│   ├── index.ts                    # Worker entrypoint + /mcp handler
│   ├── mcp/
│   │   ├── server.ts               # Tool registration, descriptions, schemas
│   │   ├── auth.ts                 # Identity and scopes
│   │   └── tools/
│   │       ├── create-post.ts
│   │       ├── research-topic.ts
│   │       ├── search-reference-bank.ts
│   │       ├── evaluate-post.ts
│   │       ├── register-published-post.ts
│   │       ├── get-post-performance.ts
│   │       └── get-learning-report.ts
│   ├── domain/
│   │   ├── contracts.ts
│   │   ├── errors.ts
│   │   ├── post-features.ts
│   │   ├── scoring.ts
│   │   └── x-length.ts
│   ├── services/
│   │   ├── create-post-workflow.ts
│   │   ├── research-orchestrator.ts
│   │   ├── generation.ts
│   │   ├── evaluation.ts
│   │   ├── revision.ts
│   │   ├── performance-sync.ts
│   │   └── learning.ts
│   ├── providers/
│   │   ├── research-provider.ts
│   │   ├── zernio.ts
│   │   ├── tavily.ts
│   │   └── openai.ts
│   ├── repositories/
│   │   ├── drafts.ts
│   │   ├── published-posts.ts
│   │   ├── metrics.ts
│   │   ├── learning.ts
│   │   └── research-sources.ts
│   └── config/
│       ├── env.ts
│       └── limits.ts
└── tests/
    ├── unit/
    ├── integration/
    ├── fixtures/
    └── e2e/
```

**Dependency rule:** `mcp/tools` → `services` → `domain`/`repositories`/`providers`. Domain logic never imports Cloudflare request handlers or provider SDK response types. Providers never decide scoring policy.

---

## 10. Implementation roadmap

### Phase 0 — Project foundation

- [ ] Initialize strict TypeScript Worker project, formatting, linting, tests, and environment typing.
- [ ] Implement authenticated stateless MCP `/mcp` entrypoint; verify a client can list tools.
- [ ] Configure D1 migrations and bindings; configure KV cache and secret bindings.
- [ ] Establish request IDs, input/output schemas, error handling, and cost/latency budgets.

**Done when:** An authorized MCP client can connect, discover a test tool, and read/write a D1 test record.

### Phase 1 — Deterministic core + generation

- [ ] Implement X-aware weighted length validator and hard gates.
- [ ] Implement `rubric-1.0` evaluator and batch candidate comparison.
- [ ] Implement OpenAI generation of four distinct candidates and bounded revision.
- [ ] Implement `create_post` with no-research/empty-bank fallback and persist the final draft.
- [ ] Return exactly one copy-ready post with labeled heuristic analytics.

**Done when:** A topic alone produces a valid post and stored draft ID, even when no historical data exists.

### Phase 2 — Research providers

- [ ] Implement Zernio X search adapter and normalized evidence mapping.
- [ ] Implement Tavily search adapter and source verification pipeline.
- [ ] Add provider registry, query planner, deduplication, KV TTL cache, and fallbacks.
- [ ] Add a documented contract for registering further research adapters.
- [ ] Test prompt-injection and unverified breaking-news cases.

**Done when:** Current topics use attributed research and provider outages degrade safely.

### Phase 3 — Reference bank + publication linking

- [ ] Implement draft/evaluation/research-source persistence and indexes.
- [ ] Implement `register_published_post` with ownership, ID/URL validation, and actual-text tracking.
- [ ] Implement `search_reference_bank` with account-scoped, comparable historical examples.
- [ ] Ensure generated-only drafts never appear as observed performance examples.

**Done when:** A generated post can be manually published, linked, and retrieved with its full provenance.

### Phase 4 — Measured analytics + feedback

- [ ] Implement Zernio analytics retrieval, pending/failed states, and field normalization.
- [ ] Implement `get_post_performance` as an idempotent fetch-and-persist operation.
- [ ] Store timestamped metric snapshots and derived rates with explicit denominators.
- [ ] Implement basic cohort summaries and `get_learning_report`.
- [ ] Test repeat fetch, missing metrics, edited published text, and provider sync delays.

**Done when:** Calling `get_post_performance` updates the bank and the next post can access the new evidence.

### Phase 5 — Controlled self-improvement

- [ ] Add versioned content features and comparable-cohort retrieval.
- [ ] Introduce evidence-assisted tie-breakers only when minimum data thresholds are met.
- [ ] Measure whether historical evidence improves selection on time-separated test posts.
- [ ] Expose sample sizes, uncertainty, and applied learning version in tool output.
- [ ] Add model calibration only after enough diverse outcomes exist; require validation and rollback.

**Done when:** The system demonstrably learns from observed performance **without** falsely claiming reliable virality probabilities.

### Phase 6 — Hardening

- [ ] Test at least two distinct MCP clients against identical tool contracts.
- [ ] Implement rate limits, per-owner quotas, retries, budget alerts, and safe secret handling.
- [ ] Document privacy/retention/deletion, provider terms, and credential rotation.
- [ ] Measure p50/p95 tool latency, failure rates, and provider spend.

**Done when:** The service is secure, cost-bounded, and resilient to common provider failures.

---

## 11. Testing and acceptance criteria

### Unit tests

- [ ] Input schemas reject empty topics, malformed X IDs, invalid limits, and contradictory constraints.
- [ ] Weighted X length handles URLs, emojis, Unicode, and line breaks.
- [ ] Scoring totals 100; hard-gate failures override high scores; revised text invalidates old evaluations.
- [ ] Metrics normalization distinguishes `0` from `null`/missing; no division by zero.
- [ ] Post-age calculations and cohort selection use consistent observation windows.
- [ ] Idempotency prevents duplicate publication links and metric snapshots.
- [ ] Historical patterns cannot be inferred from fewer than the configured minimum observations.

### Integration tests

- [ ] Zernio search + Tavily search → normalized evidence with source URLs and timestamps.
- [ ] One research provider times out → partial research response and valid evergreen fallback where appropriate.
- [ ] Both research providers unavailable for breaking news → no invented claims.
- [ ] Empty reference bank → valid generation and `insufficient_data` learning status.
- [ ] Populated bank → comparable posts retrieved only for the authorized owner.
- [ ] Generated draft → manual publication link → Zernio metrics → snapshot → refreshed summary.
- [ ] Re-fetch unchanged metrics → no duplicate snapshot; newer metrics → new snapshot.
- [ ] Zernio `202`/unavailable metrics → no fake zero observation.
- [ ] Published text edited by user → stored actual text, correct attribution.
- [ ] Malicious instructions in search results cannot control the agent or leak credentials.

### End-to-end acceptance matrix

| Scenario | Expected result |
|---|---|
| Agent says “write about AI agents” | One copy-ready post, heuristic analytics, draft ID |
| Agent specifies humor and developers | Preferences respected; no forced follow-up questions |
| Agent asks for a breaking-news claim without verification | Explicit blocker or safe rewrite; no invented citations |
| First-ever request with an empty bank | Works without historical metrics |
| User links a manually published post | Publication record saved; ownership and edits tracked |
| User requests performance | Authorized Zernio metrics returned **and** persisted in bank |
| Same performance requested twice | No duplicate snapshots or inflated learning sample |
| Historical data grows to threshold | Versioned, bounded evidence-assisted selection can activate |
| Two MCP-compatible hosts use `create_post` | Same input/output contracts, no host-specific business logic |
| Provider quota exceeded | Actionable error, no leaked credentials, no fabricated metrics |

### Definition of done (first usable release)

- [ ] Remote MCP server works through authenticated Streamable HTTP on Cloudflare Workers.
- [ ] TypeScript contracts, Zod validation, and deterministic X-length checks are in place.
- [ ] Zernio and Tavily research work through an extensible provider interface.
- [ ] Topic-only request returns one original post and transparent pre-publication analytics.
- [ ] D1 stores content, evaluation, sources, publication links, and observed metric snapshots.
- [ ] A performance lookup updates the reference bank, and later requests can use those observations.
- [ ] Cold start, missing metrics, provider failures, and security controls are tested.
- [ ] No automatic publishing, fake virality predictions, or uncontrolled self-modification.

---

## 12. Documentation and provider references

These are implementation references; verify provider features, permissions, and pricing against current documentation before writing each adapter.

- [Model Context Protocol specification](https://modelcontextprotocol.io/specification)
- [Cloudflare: Build a remote MCP server (stateless Streamable HTTP)](https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/)
- [Cloudflare: MCP transport](https://developers.cloudflare.com/agents/model-context-protocol/protocol/transport/)
- [Cloudflare: Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare: D1 bindings and typed queries](https://developers.cloudflare.com/d1/worker-api/)
- [Cloudflare: D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [Zernio API documentation](https://docs.zernio.com/)
- [Zernio: X search capability and API changelog](https://docs.zernio.com/changelog)
- [Zernio: Get post analytics](https://docs.zernio.com/core/analytics)
- [Zernio: X platform limitations](https://docs.zernio.com/platforms/twitter/reference)
- [Tavily Search API](https://docs.tavily.com/documentation/api-reference/endpoint/search)
- [X Help: Post length and format](https://help.x.com/en/using-x/types-of-posts)

**Guiding engineering principle:** Keep the MCP interface simple, the data provenance explicit, and the feedback loop measurable. The server should become better at selecting content **because it learns from verified outcomes**, not because it claims to have found a guaranteed algorithm exploit.