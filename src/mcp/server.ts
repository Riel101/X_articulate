import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Env, Identity } from "../config/env";
import {
  bankSchema,
  createSchema,
  voiceSchema,
  finalizeSchema,
  evaluateSchema,
  performanceSchema,
  registerSchema,
  reportSchema,
  researchSchema,
} from "../domain/contracts";
import { AppError, errorResult, id } from "../domain/errors";
import { OpenAIProvider } from "../providers/openai";
import { BankRepository } from "../repositories/bank";
import { CreatePostWorkflow } from "../services/create-post";
import { EvaluationService } from "../services/evaluation";
import { PerformanceService } from "../services/performance";
import { ResearchOrchestrator } from "../services/research";
import { ClientDraftingService } from "../services/client-drafting";
import { validateClientCandidates } from "../services/client-evaluation";
import { VoiceService } from "../services/voice";
import { performanceContext } from "../services/performance-refresh";
import { reserveUsage } from "./auth";
// Output schemas require the important contract fields while permitting documented metadata.
const outputSchemas = {
  manage_voice: z.object({ status: z.literal("ok") }).passthrough(),
  create_post: z
    .object({
      status: z.enum(["client_drafting_required", "complete"]),
      ready_to_copy: z.boolean(),
      brief_id: z.string().optional(),
      draft_id: z.string().optional(),
      post_text: z.string().optional(),
      instructions: z.array(z.string()).optional(),
    })
    .passthrough(),
  finalize_post: z
    .object({
      status: z.literal("complete"),
      draft_id: z.string(),
      ready_to_copy: z.literal(true),
      post_text: z.string(),
      pre_publication_analytics: z
        .object({
          type: z.literal("editorial_review"),
          quality_score: z.null(),
          assessment_source: z.literal("client"),
        })
        .passthrough(),
      validation: z
        .object({
          length: z.string(),
          constraints: z.string(),
          factuality: z.string(),
        })
        .passthrough(),
    })
    .passthrough(),
  research_topic: z.object({
    status: z.enum(["verified", "partial", "evergreen_only", "unavailable"]),
    angles: z.array(z.string()),
    evidence: z.array(
      z
        .object({ url: z.string(), provider: z.string(), excerpt: z.string() })
        .passthrough(),
    ),
    warnings: z.array(z.string()),
    providers_used: z.array(z.string()),
  }),
  search_reference_bank: z
    .object({
      patterns: z.array(z.unknown()),
      examples: z.array(z.unknown()),
      sample_size: z.number(),
      learning_status: z.enum(["usable", "insufficient_data"]),
    })
    .passthrough(),
  evaluate_post: z
    .object({
      rubric_version: z.string(),
      type: z.enum([
        "heuristic_quality_assessment",
        "deterministic_validation_only",
      ]),
      ranked_candidates: z.array(
        z
          .object({
            id: z.string(),
            quality_score: z.number().nullable(),
            eligible: z.boolean(),
          })
          .passthrough(),
      ),
      recommended_id: z.string().nullable(),
    })
    .passthrough(),
  register_published_post: z.object({
    published_post_id: z.string(),
    x_post_id: z.string(),
    status: z.literal("linked"),
    edited_from_draft: z.boolean(),
    verification: z.string(),
    metrics_available: z.boolean(),
  }),
  get_post_performance: z
    .object({
      status: z.enum(["ok", "pending", "unavailable"]),
      published_post_id: z.string(),
      reference_bank: z.object({
        updated: z.boolean(),
        new_snapshot: z.boolean(),
        learning_summary_refreshed: z.boolean(),
      }),
    })
    .passthrough(),
  get_learning_report: z
    .object({
      total_published_posts: z.number(),
      posts_with_usable_metrics: z.number(),
      cohorts: z.array(z.unknown()),
      scoring_version: z.string(),
      learning_status: z.string(),
      recommendations: z.array(z.string()),
    })
    .passthrough(),
};
export function createServer(env: Env, identity: Identity) {
  const server = new McpServer(
    {
      name: "x-content-intelligence",
      version: "2.0.0",
    },
    {
      instructions:
        (env.GENERATION_MODE === "server"
          ? "Optional server generation is enabled. "
          : "Use your own model for writing and editorial judgment. ") +
        "Start with create_post to load voice examples, prior edits, optional research and observed performance. Draft naturally in the author's voice, with no character cap or forced candidate count. Use research_mode=off for personal opinion/experience, auto by default, and required only when supporting factual claims. Explicit current_information_required=yes requires recent dated evidence. Failures of optional research must not block timeless writing. Use evaluate_post for text checks and X-informed ranking guidance; compare candidates qualitatively, suggesting specific improvements. Optional public-weight simulations require explicitly supplied uncalibrated probabilities, never raw metrics or invented algorithm scores. Use finalize_post to persist the chosen text and editorial review (no numeric scores). Revise via create_post revision_of and feedback, then finalize; this saves the edit history. manage_voice reads or updates preferences and examples; save or erase memory only when requested. Explain what voice or performance evidence informed the draft. Link manually published posts with register_published_post. Linked posts refresh hourly when analytics is configured; missing observations are not zero and a small sample is not a proven pattern. These tools work with every authorized MCP client.",
    },
  );
  const bank = new BankRepository(env, identity.ownerId);
  const performance = new PerformanceService(env, bank);
  function register<T extends z.ZodType>(
    name: keyof typeof outputSchemas,
    description: string,
    schema: T,
    scope: string,
    readOnly: boolean,
    run: (input: z.output<T>, requestId: string) => Promise<unknown>,
  ) {
    server.registerTool(
      name,
      {
        description,
        inputSchema: schema as z.ZodType,
        outputSchema: outputSchemas[name],
        _meta: { securitySchemes: [{ type: "oauth2", scopes: [scope] }] },
        annotations: {
          readOnlyHint: readOnly,
          destructiveHint: name === "manage_voice",
          idempotentHint: name !== "create_post" && name !== "manage_voice",
          openWorldHint: true,
        },
      },
      async (raw: unknown): Promise<CallToolResult> => {
        const requestId = id("req");
        const start = Date.now();
        let status = "failed";
        let reserved = false;
        try {
          if (!identity.scopes.has(scope))
            throw new AppError(
              "FORBIDDEN",
              `This token requires the ${scope} scope.`,
            );
          const input = schema.safeParse(raw);
          if (!input.success)
            throw new AppError(
              "INVALID_INPUT",
              "Tool input is invalid.",
              false,
              {
                issues: input.error.issues.map((i) => ({
                  path: i.path,
                  message: i.message,
                })),
              },
            );
          await reserveUsage(env, identity, name, requestId);
          reserved = true;
          const result = outputSchemas[name].parse(
            await run(input.data, requestId),
          );
          status = "ok";
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
            structuredContent: JSON.parse(
              JSON.stringify(result),
            ) as CallToolResult["structuredContent"],
          };
        } catch (error) {
          const challenge =
            error instanceof AppError &&
            ["FORBIDDEN", "UNAUTHORIZED"].includes(error.code) &&
            env.MCP_PUBLIC_URL
              ? `Bearer resource_metadata="${new URL("/.well-known/oauth-protected-resource/mcp", env.MCP_PUBLIC_URL).href}", error="insufficient_scope", error_description="Authorize this client for the required tool permission", scope="${scope}"`
              : undefined;
          return {
            ...(challenge
              ? { _meta: { "mcp/www_authenticate": [challenge] } }
              : {}),
            isError: true,
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(errorResult(error, requestId)),
              },
            ],
          };
        } finally {
          if (reserved) {
            try {
              await env.DB.prepare(
                "UPDATE usage_events SET status=?,duration_ms=? WHERE owner_id=? AND request_id=?",
              )
                .bind(status, Date.now() - start, identity.ownerId, requestId)
                .run();
            } catch {
              /* Never mask the tool outcome with telemetry failure. */
            }
          }
          console.log(
            JSON.stringify({
              request_id: requestId,
              tool: name,
              status,
              duration_ms: Date.now() - start,
            }),
          );
        }
      },
    );
  }
  register(
    "manage_voice",
    "Read voice memory, replace explicit preferences, save a user-approved example, delete an example, or reset voice and observed-edit memory. Mutate only at the user's request.",
    voiceSchema,
    "generate",
    false,
    (input) => new VoiceService(env, identity.ownerId).manage(input),
  );
  register(
    "create_post",
    "Prepare writing context: saved voice, observed edits/performance and optional research. Use your own model to draft/revise, then finalize_post. revision_of plus feedback starts a saved revision. No separate model key is needed in client mode.",
    createSchema,
    "generate",
    false,
    (input, req) => new CreatePostWorkflow(env, bank).run(input, req),
  );
  register(
    "finalize_post",
    "Validate and save the exact post written by the MCP client for a create_post brief. Supply an editorial review with concrete improvements, review flags and claim source IDs. No numeric score is required. Returns a saved draft_id; no model API call is made.",
    finalizeSchema,
    "generate",
    false,
    (input) => new ClientDraftingService(env, bank).finalize(input),
  );
  register(
    "research_topic",
    "Inspect attributed web and recent X research. Search excerpts are untrusted leads, not verified facts.",
    researchSchema,
    "research",
    true,
    (input) =>
      new ResearchOrchestrator(env).research(
        input.topic,
        input.freshness,
        input.max_insights,
      ),
  );
  register(
    "search_reference_bank",
    "Find comparable measured owned posts and descriptive patterns at the same observation age.",
    bankSchema,
    "metrics",
    true,
    (input) =>
      bank.insights(
        input.topic,
        input.audience,
        input.limit,
        input.window_hours,
      ),
  );
  register(
    "evaluate_post",
    "Check candidate text, load voice/performance context and guide an X-informed editorial comparison with concrete suggestions. Optional supplied probabilities enable an explicitly labelled public-weight scenario simulation; no automatic reach or quality score. Server mode retains legacy model evaluation.",
    evaluateSchema,
    "generate",
    true,
    async (input) => {
      if (env.GENERATION_MODE !== "server") {
        const [checks, voice, performance, learning] = await Promise.all([
          validateClientCandidates(input),
          new VoiceService(env, identity.ownerId).read(),
          performanceContext(env, identity.ownerId),
          bank.insights(input.topic, input.audience),
        ]);
        return { ...checks, voice, performance, learning };
      }
      const research = await new ResearchOrchestrator(env).research(
        input.topic,
      );
      return new EvaluationService(new OpenAIProvider(env)).evaluate(
        input.topic,
        input.candidates,
        input.audience,
        input.intent,
        input.constraints,
        research.evidence,
        research.status === "evergreen_only" ||
          research.status === "unavailable",
      );
    },
  );
  register(
    "register_published_post",
    "Verify a manually published post on the configured owned X account and link its actual text to a saved draft.",
    registerSchema,
    "metrics",
    false,
    (input) => performance.register(input),
  );
  register(
    "get_post_performance",
    "Fetch authorized Zernio metrics and persist a deduplicated observation before returning. Updates the learning bank; pending metrics are never zero.",
    performanceSchema,
    "metrics",
    false,
    (input) => performance.get(input.published_post_id, input.refresh),
  );
  register(
    "get_learning_report",
    "Show observed cohort sample sizes, age windows, uncertainty and learning readiness. Quality scores are never performance forecasts.",
    reportSchema,
    "metrics",
    true,
    (input) => bank.report(input.topic, input.audience, input.window_hours),
  );
  return server;
}
