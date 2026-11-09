import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Env, Identity } from "../config/env";
import {
  bankSchema,
  createSchema,
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
import { reserveUsage } from "./auth";
// Output schemas require the important contract fields while permitting documented metadata.
const outputSchemas = {
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
          type: z.literal("client_heuristic_quality_assessment"),
          quality_score: z.number(),
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
      version: "1.1.0",
    },
    {
      instructions:
        (env.GENERATION_MODE === "server"
          ? "Server generation is enabled: create_post generates, evaluates and saves a post internally. Use its returned post_text and draft_id directly. "
          : "Client generation is enabled. ") +
        "Start with create_post. In client mode it returns status=client_drafting_required with a persisted research brief, preferences, rubric and historical patterns. YOU, the MCP host, must use your own model to write four candidates, evaluate and revise them, then call finalize_post with the chosen text, brief_id and your assessment. No separate model API key is required in client mode. evaluate_post provides deterministic length/constraint checks in client mode, not a model quality score. Only present the final saved post after finalize_post returns a draft_id. Explicit server mode may instead complete create_post directly. Publish manually; later link with register_published_post and fetch observed performance with get_post_performance. Never claim that directly drafted text was server-generated or independently scored. These instructions apply to every authorized MCP host.",
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
          destructiveHint: false,
          idempotentHint: name !== "create_post",
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
    "create_post",
    "Start a post workflow. In client mode this returns a persisted research brief: use your own model to draft and assess four candidates, then call finalize_post. No server LLM key is needed. Explicit server mode generates the post internally.",
    createSchema,
    "generate",
    false,
    (input, req) => new CreatePostWorkflow(env, bank).run(input, req),
  );
  register(
    "finalize_post",
    "Validate and save the exact post written by the MCP client for a create_post brief. Supply your client quality assessment and claim source IDs. Returns a saved draft_id; no model API call is made.",
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
    "Check candidates. Client mode validates weighted X length and explicit constraints, returning null quality scores for the client to assess. Server mode performs a model-backed heuristic evaluation.",
    evaluateSchema,
    "generate",
    true,
    async (input) => {
      if (env.GENERATION_MODE !== "server")
        return validateClientCandidates(input);
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
