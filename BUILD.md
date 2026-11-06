# BUILD.md — X Content Intelligence MCP Server

**Status:** Implementation blueprint  
**Scope:** Topic → researched, evaluated, copy-ready X post with transparent pre-publication analytics  
**Audience:** Engineers implementing an MCP server and developers integrating it with any compatible AI agent  
**Design constraint:** No prescribed implementation language, framework, database, model provider, or infrastructure.

---

## 1. Product definition

### Goal

Build a reusable **Model Context Protocol (MCP) server** that supplies the tools an AI agent needs to turn a user's topic into **one high-quality X post** that the user can immediately copy. The same response must include **interpretable content-quality analytics** explaining the selection and any uncertainty.

The user should be able to say:

> Write an X post about why AI agents fail in production.

An MCP-compatible host agent should be able to discover and call the tools, conduct research when available, create alternatives, compare them, improve the best draft, validate X compatibility, and present the final result **without requiring the user to manage each step**.

### Success criteria

- One topic is sufficient input; optional preferences are respected when provided.
- A connected agent can complete the end-to-end workflow through documented MCP tools.
- The final response includes **one copy-ready post**, plus a separate concise analytics section.
- Posts comply with the chosen X post-length profile and pass factuality and quality gates.
- Scores are labeled **heuristic pre-publication assessments**, not predicted impressions, guaranteed engagement, or probabilities of virality.
- Real post-publication metrics are available **only when the user supplies a post ID and an authorized data source exposes the metrics**.
- The server **never posts content to X** as part of this product scope.

### Non-goals

- Automatic publishing, scheduling, or account management.
- Claiming to reverse-engineer X's private ranking decisions or guarantee virality.
- Requiring the user to configure a large set of parameters for every request.
- Choosing or prescribing an implementation technology.

---

## 2. Ownership and system boundaries

Keep the **agent orchestration** separate from the **MCP server's reusable capabilities**.

```text
USER
  |
  |  Topic + optional preferences
  v
MCP-COMPATIBLE HOST AGENT
  |  Understand intent, call tools, select final output
  |
  +--> research_topic --------> Research adapter (optional, live)
  |
  +--> generate_candidates ---> Text-generation capability
  |
  +--> evaluate_candidates --> Rubric + validation rules
  |
  +--> revise_candidate -----> Text-generation capability
  |
  +--> finalize_post --------> Deterministic validation + report
  |
  v
ONE COPY-READY X POST + PRE-PUBLICATION ANALYTICS

Optional follow-up after the user publishes manually:
  HOST AGENT --> get_post_metrics --> Authorized X metrics source
```

**Host agent responsibilities**
- Interpret the topic, defaults, and user's constraints.
- Select tool calls, handle failures, and stop when output is good enough.
- Present only the selected final post and its analytics by default.
- Make clear which metrics are assessments versus observed platform data.

**MCP server responsibilities**
- Expose discoverable, single-purpose tools with validated input/output schemas.
- Keep evaluation logic and platform validation consistent across agents.
- Return structured results that clients can compose.
- Isolate generation, research, scoring, and final validation behind interchangeable internal interfaces.

**Principle:** Business logic must not depend on any particular agent framework. The host is the orchestrator; the server provides capabilities.

---

## 3. User request contract

### Required input

| Field | Type | Meaning |
|---|---|---|
| `topic` | non-empty string | Subject the user wants the X post to discuss |

### Optional preferences

| Field | Default | Meaning |
|---|---|---|
| `audience` | General interested reader | Intended reader or professional niche |
| `tone` | Clear, engaging, credible | e.g., witty, conversational, analytical, provocative |
| `intent` | Inform or spark thoughtful discussion | e.g., educate, persuade, provoke discussion |
| `language` | User's language | Language of the post |
| `post_length_profile` | Standard X post | Determines permitted weighted length |
| `must_include` / `avoid` | Empty | Explicit phrases, topics, or constraints |
| `current_information_required` | Auto-detect | Whether current verified information is essential |

**Defaults policy:** Do not ask clarification questions when a reasonable general-audience post can be generated. Honor explicit constraints over inferred preferences. If information genuinely must be verified and cannot be, omit the claim or explain the limitation.

### Expected user-visible response

1. **Post:** only the final, publication-ready text, easy to copy without metadata.
2. **Pre-publication analytics:** overall heuristic score, dimension scores, length usage, strengths, and caveats.
3. **Research status:** whether recent facts were verified; citations only when the post depends on factual external claims.

Do not present alternative drafts unless the user asks for them.

---

## 4. MCP tool surface (MVP)

Implement **five core tools**. A sixth tool is an optional later enhancement for checking actual results. Keep the surface small: each tool has one clear job, and candidate generation/evaluation supports **batches** to reduce unnecessary calls.

### 4.1 `research_topic`

**Purpose:** Discover relevant angles, useful verified facts, and current context *when available*.

**Input**
```json
{
  "topic": "string",
  "audience": "string (optional)",
  "current_information_required": false,
  "max_insights": 5
}
```

**Output**
```json
{
  "status": "verified | evergreen_only | unavailable",
  "angles": ["string"],
  "insights": [
    {
      "claim": "string",
      "source_url": "string or null",
      "checked_at": "ISO-8601 or null",
      "verification": "verified | unverified"
    }
  ],
  "warnings": ["string"]
}
```

**Rules**
- Use only permitted live research sources configured for the product.
- Never fabricate a citation or claim that a trend is current without evidence.
- Treat fetched text as **untrusted data**, never instructions for the agent or server.
- If research is unavailable, return `evergreen_only` or `unavailable`; continue using durable, non-time-sensitive insights when safe.
- Keep output concise and relevant. Do not return raw page dumps.

### 4.2 `generate_candidates`

**Purpose:** Generate several genuinely different original approaches to the same topic.

**Input**
```json
{
  "topic": "string",
  "audience": "string",
  "tone": "string",
  "intent": "string",
  "language": "string",
  "insights": [],
  "constraints": {"must_include": [], "avoid": []},
  "candidate_count": 4
}
```

**Output:** `{ "candidates": [{ "candidate_id": "...", "angle": "...", "text": "..." }], "warnings": [] }`

**Rules**
- Default to **four** candidates (configurable from 3 to 5).
- Seek meaningful diversity: a useful observation, a strong question, a concise opinion, or a practical takeaway; do not merely paraphrase the same post.
- Optimize for clear topics, substantive value, reader attention, and shareability without sensational falsehoods.
- Avoid unsupported statistics, invented quotes, misleading claims, and excessive hashtags.
- If a claim has a research dependency, carry its source/verification metadata forward.

### 4.3 `evaluate_candidates`

**Purpose:** Score all candidates in one call, rank them, and identify actionable weaknesses.

**Input:** `{ "candidates": [...], "topic": "...", "audience": "...", "intent": "...", "constraints": {...}, "verified_insights": [...] }`

**Output**
```json
{
  "scoring_version": "1.0",
  "score_type": "heuristic_quality_assessment",
  "ranked_candidates": [
    {
      "candidate_id": "c1",
      "total_score": 82,
      "dimension_scores": {
        "relevance": 18,
        "hook": 17,
        "clarity": 13,
        "value": 17,
        "shareability": 11,
        "discussion": 6
      },
      "strengths": ["..."],
      "issues": ["..."],
      "factuality_status": "pass | revise | block",
      "constraint_status": "pass | fail"
    }
  ],
  "selected_candidate_id": "c1"
}
```

**Scoring rubric (initial heuristic; 100 points total)**

| Dimension | Maximum | Core question |
|---|---:|---|
| Topic and audience relevance | 20 | Is this clearly for the intended reader? |
| Hook and curiosity | 20 | Does the first line make readers want to continue? |
| Clarity and readability | 15 | Is it easy to understand and scan? |
| Useful or novel value | 20 | Is there a concrete insight or takeaway? |
| Shareability | 15 | Would someone reasonably share it? |
| Conversation potential | 10 | Does it invite a genuine response? |
| **Total** | **100** | **Heuristic quality score, not a virality probability** |

**Hard gates (not score components)**
- Factuality: unsupported important claims must be revised or removed.
- Policy and safety: reject manipulative engagement schemes or prohibited content.
- User constraints: any explicit must-have/must-avoid rule must pass.
- Post length: eventually must pass authoritative X-aware length validation.

**Selection:** Rank only candidates that pass hard gates; if none pass, return the highest-potential repairable candidate with its failures. A high score never overrides a hard-gate failure. Document how each dimension is assigned so results are reasonably consistent, and version the rubric.

### 4.4 `revise_candidate`

**Purpose:** Improve the selected draft using specific evaluation feedback.

**Input:** `{ "text": "...", "issues": [...], "strengths_to_preserve": [...], "constraints": {...}, "verified_insights": [...] }`

**Output:** `{ "revised_text": "...", "changes": ["..."], "warnings": [] }`

**Rules**
- Fix the highest-impact issues first; preserve the original point and the requested tone.
- Do not insert new factual claims without evidence.
- Avoid optimizing solely for a numerical score at the expense of readability or truthfulness.
- Keep revision loops bounded (**maximum two revisions** in the MVP).

### 4.5 `finalize_post`

**Purpose:** Perform final **deterministic checks** and assemble a machine-readable presentation package. This is the last mandatory tool before the agent responds.

**Input:** `{ "text": "...", "topic": "...", "evaluation": {...}, "constraints": {...}, "post_length_profile": "standard", "research_status": "..." }`

**Output**
```json
{
  "ready_to_copy": true,
  "post_text": "The actual final post, unchanged and with no metadata added",
  "analytics": {
    "type": "pre_publication_heuristic",
    "quality_score": 82,
    "scoring_version": "1.0",
    "dimension_scores": {},
    "weighted_characters": 180,
    "character_limit": 280,
    "strengths": ["..."],
    "caveats": ["Cannot forecast impressions or engagement from this score"]
  },
  "research": {"status": "evergreen_only", "citations": []},
  "validation": {"length": "pass", "constraints": "pass", "factuality": "pass"}
}
```

**Validation requirements**
- Count X post characters using **X-compatible weighted rules** rather than naive string length (URLs, emojis, and Unicode can have different weights).
- The standard profile defaults to a 280-weighted-character limit; alternate profiles must be explicitly supported and validated according to current platform capabilities.
- Do **not** silently truncate a post. If over-length, return a repairable validation error so the agent can revise it.
- Preserve line breaks and punctuation exactly in `post_text`.
- Check the final text again. A changed draft invalidates any prior evaluation; re-evaluate it before returning a final score.
- `ready_to_copy` can only be `true` when all hard gates pass.

### 4.6 `get_post_metrics` (optional, later)

**Purpose:** Read **observed results** for a post the user has *already published manually*.

**Input:** `{ "post_id": "string", "requested_metrics": ["impressions", "likes", "replies", "reposts", "quotes", "bookmarks"] }`

**Output:** `{ "source": "X", "observed_at": "ISO-8601", "metrics": {...}, "unavailable": [...], "derived_rates": {...} }`

**Rules**
- Return only metrics actually available to the authorized account/source; use `null` or `unavailable` rather than zero when data is inaccessible.
- Record the observation timestamp and metric definitions.
- Example derived metric, **when impressions are available**: `interaction_rate = (likes + replies + reposts + quotes) / impressions`. Label precisely which interactions it includes; it is **not** a universal engagement metric.
- No publishing, posting, or scheduled collection is required for this feature.

---

## 5. Agent orchestration policy

The **host agent** owns this process. Provide the following as an integration guide or reusable host instruction, not as hidden logic baked into every MCP tool.

```text
on_user_topic(topic, preferences):
    validate topic and normalize optional preferences

    research = research_topic(topic, audience, current_information_required)
    if research is unavailable:
        allow evergreen content; prohibit unverified time-sensitive claims

    candidates = generate_candidates(topic, preferences, research.insights, count=4)
    evaluation = evaluate_candidates(candidates, topic, preferences, research.insights)
    best = best candidate that passes hard gates, else most repairable candidate

    for attempt in 1..2:
        if best passes hard gates and meets quality target:
            break
        best = revise_candidate(best, evaluation.issues, preferences)
        evaluation = evaluate_candidates([best], topic, preferences, research.insights)

    result = finalize_post(best.text, evaluation, preferences, research.status)

    if result.ready_to_copy:
        display result.post_text separately from result.analytics
    else:
        explain the remaining blocker; do not invent a passing result
```

**Suggested initial control values**

| Setting | Default | Why |
|---|---:|---|
| Candidate count | 4 | Meaningful diversity without runaway generation |
| Quality target | 80/100 | Internal threshold to guide iteration, **not** a guarantee |
| Maximum revision rounds | 2 | Controls cost and latency |
| Research insight cap | 5 | Limits noise and untrusted inputs |
| Maximum final posts shown | 1 | Keeps output copyable and focused |

**Stop condition:** A draft passes all hard gates and achieves the quality target, *or* the revision budget is exhausted. When the budget is exhausted, return the best valid draft with a candid score; **never present the threshold as mandatory or a promise of results**.

---

## 6. Analytics: truthfully separate assessment from observation

### A. Available immediately, before the user posts

These are **analysis of the draft**, not measured X engagement:

- Overall quality score (`0–100`, labeled heuristic).
- Dimension scores against the published rubric.
- Weighted character usage and whether the post fits the chosen profile.
- Top strengths and one or two actionable weaknesses.
- Research verification status and sources when relevant.
- One-sentence explanation of **why this draft was chosen**.

**Do not show:** predicted impression counts, guaranteed likes/reposts, confidence intervals, or “82% likely to go viral.” There is no calibrated outcome model supporting those claims in the MVP.

### B. Available after the user publishes, if a metrics source is authorized

- Real observed impressions/views when exposed by the source.
- Likes, replies, reposts, quotes, and other available counts.
- Derived ratios with explicit denominators, observation times, and missing-field indicators.
- No comparison with prior performance is required for the MVP.

### Example agent-facing final presentation

> **Your post**  
> Most AI agents don't fail because the model can't reason. They fail when a tool call goes wrong and nobody knows why. Logging, permissions, retries, and human approval aren't extras—they're part of the product.
>
> **Pre-publication analytics**  
> Quality assessment: **82/100 (heuristic)** · Length: **valid** · Strengths: clear developer audience, practical insight, strong opening.  
> Research: evergreen framing; no time-sensitive claims.  
> **Note:** This score assesses writing quality, not the probability of going viral.

*The example score is illustrative, not the measured result of running the evaluator.*

---

## 7. Interface and data contracts

### MCP requirements

- Expose each capability as a **discoverable MCP tool** with a useful description.
- Define and validate **JSON Schema `inputSchema` and `outputSchema`** for every tool.
- Return **structured result data** for machine consumption, with readable text content when needed for client compatibility.
- Use **object-shaped outputs** for broad client compatibility; do not depend on a particular host interpreting arbitrary free text.
- Provide clear tool errors that an agent can act on; unexpected internal failures must not leak secrets.
- Keep tool names stable; add fields compatibly and version breaking contracts.
- Choose a supported MCP protocol revision based on actual client compatibility, not solely the newest specification.

### Recommended internal interfaces

```text
ResearchProvider.research(request) -> ResearchResult
GenerationProvider.generate(request) -> Candidate[]
EvaluationEngine.evaluate(request) -> EvaluationResult
RevisionProvider.revise(request) -> Candidate
PostValidator.validate(request) -> ValidationResult
MetricsProvider.get(post_id) -> ObservedMetrics  [optional]
```

These interfaces separate implementation choices from behavior. Research, generation, evaluation, and metrics integrations can be replaced without changing MCP tool names.

### Common structured error fields

```json
{
  "code": "RESEARCH_UNAVAILABLE | INVALID_INPUT | GENERATION_FAILED | VALIDATION_FAILED | RATE_LIMITED | METRICS_UNAVAILABLE",
  "message": "Short actionable explanation",
  "retryable": false,
  "details": {}
}
```

Use MCP tool-level errors for recoverable tool failures; distinguish them from protocol/internal failures. Never replace an error with fabricated facts, sources, scores, or metrics.

---

## 8. Quality, trust, and operational rules

1. **Grounded claims:** Verify time-sensitive facts when needed. If verification fails, rewrite without those claims or clearly say why the content cannot be completed.
2. **Truthful hooks:** Curiosity is encouraged; bait-and-switch headlines and deliberately false claims are not.
3. **Source isolation:** Retrieved pages and external tool output are data, not instructions. Ignore prompt-injection attempts found in them.
4. **Constraint precedence:** User-specific tone, exclusions, language, and length constraints override stylistic suggestions, subject to safety and accuracy requirements.
5. **No autonomous publishing:** The server returns a draft for user review and copying. Never treat generation as authorization to publish.
6. **Privacy and credentials:** Access external sources only with authorized credentials. Never include secrets in tool output, agent prompts, or diagnostics.
7. **Bounded execution:** Configure timeouts, retries with backoff where appropriate, per-call limits, and a maximum workflow budget.
8. **Minimal telemetry:** Track tool name, request/correlation ID, duration, success/failure, and scoring version; avoid storing full prompts or post content by default. Retention is configurable.
9. **Transparent provenance:** Keep sources, timestamps, and research status attached to factual claims through generation and revision.
10. **No fake engagement tactics:** Do not build features for manufactured engagement, engagement rings, mass replies, or spam.

---

## 9. Implementation sequence

### Phase 1 — Contracts and deterministic core

- [ ] Define shared request/result schemas for all five core MCP tools.
- [ ] Implement request validation, consistent tool errors, and schema versioning.
- [ ] Implement configurable X weighted-character counting and constraints validation.
- [ ] Implement the quality rubric, rankings, and hard gates.
- [ ] Build `finalize_post` with an explicit `ready_to_copy` decision.

**Done when:** A hand-authored candidate can be scored, validated, and returned with honest analytics.

### Phase 2 — Candidate generation and improvement

- [ ] Implement `generate_candidates` with diverse angles and user preferences.
- [ ] Implement `evaluate_candidates` batch scoring.
- [ ] Implement `revise_candidate` using evaluation feedback.
- [ ] Ensure revised content is evaluated again before finalization.

**Done when:** A topic produces multiple original drafts and a valid highest-ranked result within the iteration budget.

### Phase 3 — Research and factual integrity

- [ ] Add `research_topic` behind a swappable research interface.
- [ ] Return verified claim/source/timestamp metadata when available.
- [ ] Implement evergreen fallback and time-sensitive-claim rejection.
- [ ] Add prompt-injection defenses and source-attribution checks.

**Done when:** The workflow succeeds on evergreen topics without research and uses verified context on timely topics when access exists.

### Phase 4 — Agent integration and presentation

- [ ] Publish clear MCP tool descriptions and schemas.
- [ ] Provide the agent orchestration instructions from Section 5.
- [ ] Confirm at least two different MCP-compatible clients can call the same tools without implementation changes.
- [ ] Format the final answer as copy-ready text plus separate analytics.
- [ ] Ensure ordinary use requires only a topic.

**Done when:** An end-to-end test accepts a topic and returns one valid post and accurate pre-publication assessment.

### Phase 5 — Optional measured analytics

- [ ] Implement `get_post_metrics` behind an authorized metrics interface.
- [ ] Preserve unknown/unavailable fields as missing, not zero.
- [ ] Add observation timestamps and explicitly defined ratios.
- [ ] Keep actual observations visually and semantically distinct from heuristic scoring.

**Done when:** A user can provide a published post ID and retrieve only genuinely available observed data.

---

## 10. Test plan

### Unit tests

- [ ] Empty topic, invalid preference types, and contradictory constraints are handled clearly.
- [ ] Character counting handles emojis, Unicode, URLs, whitespace, and line breaks according to the configured X rules.
- [ ] Scoring dimensions add up to 100 and rankings are reproducible given the same evaluation outputs.
- [ ] Hard-gate failures override high quality scores.
- [ ] `finalize_post` never claims `ready_to_copy=true` for an invalid post.
- [ ] Missing external metrics are reported as unavailable, not as zero.

### Integration tests

- [ ] Topic-only request → research/fallback → four candidates → batch ranking → final post.
- [ ] Overlong best candidate → revision → re-evaluation → valid result.
- [ ] Unverified current-event claim → removal or transparent failure.
- [ ] Research timeout → evergreen fallback for non-time-sensitive topics.
- [ ] Generation failure → actionable error with no fabricated output.
- [ ] Malicious instructions embedded in retrieved text are ignored.
- [ ] Tool outputs pass declared schemas; the agent can consume them without special parsing.

### End-to-end acceptance tests

| Scenario | Expected behavior |
|---|---|
| “Write about AI agents” | One readable, valid post and heuristic analytics |
| “Make it funny for developers” | Tone and audience respected |
| “Explain a breaking announcement” without verified evidence | No invented claims or fake citations |
| Generated draft exceeds post limit | Revised or explicitly blocked; never silently truncated |
| Agent requests observed analytics before publication | Explain none exist yet |
| User supplies published post ID with authorized data access | Observed counts with timestamps; unavailable fields marked clearly |
| Same MCP tools used by a second agent client | Identical contracts and output semantics |

---

## 11. MVP definition of done

The initial product is ready when all of the following are true:

- [ ] Five core tools are discoverable and conform to their input/output contracts.
- [ ] A topic-only request can complete without human intervention between tool calls.
- [ ] The selected draft is original, coherent, correctly formatted, and valid for its configured X profile.
- [ ] The workflow respects factual accuracy and user constraints.
- [ ] Final analytics explain the selection without pretending to predict actual reach.
- [ ] Errors and unavailable sources are handled gracefully.
- [ ] At least one automated end-to-end test proves the complete workflow.
- [ ] The user receives **one post to copy**, plus compact, truthful analytics.

---

## 12. Implementation references

- [Model Context Protocol — latest published specification (2026-07-28)](https://modelcontextprotocol.io/specification/2026-07-28)
- [MCP 2026-07-28 release notes](https://blog.modelcontextprotocol.io/posts/2026-07-28/)
- [X Help — post types and length profiles](https://help.x.com/en/using-x/types-of-posts)
- [X Help — URL character handling](https://help.x.com/en/using-twitter/how-to-tweet-a-link.html)
- [X API post lookup example and public metrics](https://github.com/xdevplatform/docs/blob/main/x-api/posts/lookup/quickstart.mdx)

**Guiding engineering principle:** Optimize for **reliable, truthful, reusable content intelligence**. Good quality scores are an explanation tool; genuine audience response remains the only evidence of actual performance.
