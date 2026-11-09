import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Env, Identity } from "../config/env";
import {
  bankSchema,
  createSchema,
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
import { reserveUsage } from "./auth";
// Output schemas require the important contract fields while permitting documented metadata.
const outputSchemas = {
  create_post: z
    .object({
      draft_id: z.string(),
      ready_to_copy: z.boolean(),
      post_text: z.string(),
      pre_publication_analytics: z
        .object({
          type: z.literal("heuristic_quality_assessment"),
          quality_score: z.number(),
          weighted_characters: z.number(),
          character_limit: z.literal(280),
        })
        .passthrough(),
      research: z.object({ status: z.string() }).passthrough(),
      learning: z
        .object({ status: z.string(), comparable_post_count: z.number() })
        .passthrough(),
      validation: z.object({
        length: z.string(),
        factuality: z.string(),
        constraints: z.string(),
      }),
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
  evaluate_post: z.object({
    rubric_version: z.string(),
    type: z.literal("heuristic_quality_assessment"),
    ranked_candidates: z.array(
      z
        .object({
          id: z.string(),
          quality_score: z.number(),
          eligible: z.boolean(),
        })
        .passthrough(),
    ),
    recommended_id: z.string().nullable(),
  }),
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
        "Use create_post for the complete topic-to-post workflow; it returns one copy-ready post, heuristic analytics, and a saved draft ID. Publish manually. Later use register_published_post to link the actual publication, then get_post_performance to fetch metrics and update the reference bank. If a tool is unavailable or fails, report that limitation instead of presenting directly drafted text as server-generated. These contracts apply to any authorized MCP host.",
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
    "Research a topic, generate and evaluate distinct original drafts, and return one copy-ready X post with heuristic analytics. Persists the draft. No automatic publishing.",
    createSchema,
    "generate",
    false,
    (input, req) => new CreatePostWorkflow(env, bank).run(input, req),
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
    "Batch heuristic quality assessment with factuality, safety, originality, length and user-constraint gates.",
    evaluateSchema,
    "generate",
    true,
    async (input) => {
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
