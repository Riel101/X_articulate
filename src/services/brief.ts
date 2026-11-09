import type { Env } from "../config/env";
import type { CreateInput, ResearchResult } from "../domain/contracts";
import { AppError } from "../domain/errors";
import { BankRepository } from "../repositories/bank";
import { ResearchOrchestrator, isCurrent } from "./research";
export async function loadContext(
  env: Env,
  bank: BankRepository,
  input: CreateInput,
) {
  const current =
    input.current_information_required === "yes" ||
    (input.current_information_required === "auto" && isCurrent(input.topic));
  const required =
    input.research_mode === "required" ||
    (input.research_mode === "auto" && current) ||
    input.current_information_required === "yes";
  const shouldResearch = input.research_mode === "optional" || required;
  if (
    input.research_mode === "off" &&
    input.current_information_required === "yes"
  )
    throw new AppError(
      "INVALID_INPUT",
      "Current factual claims require research. Enable research or write timeless opinion.",
    );
  const empty: ResearchResult = {
    status: "evergreen_only",
    evidence: [],
    angles: [],
    warnings: [
      "Research was not requested. Write personal experience, opinion or timeless advice; do not invent current facts.",
    ],
    providers_used: [],
  };
  const [research, learning] = await Promise.all([
    shouldResearch
      ? new ResearchOrchestrator(env).research(
          input.topic,
          current ? "recent" : "evergreen",
        )
      : Promise.resolve(empty),
    bank.insights(input.topic, input.audience),
  ]);
  const hasWeb = research.evidence.some((e) => e.kind !== "x_post");
  const hasRecent = research.evidence.some(
    (e) =>
      e.kind !== "x_post" &&
      e.publishedAt &&
      Date.now() - Date.parse(e.publishedAt) >= 0 &&
      Date.now() - Date.parse(e.publishedAt) < 7 * 86400000,
  );
  if (required && (!hasWeb || (current && !hasRecent)))
    throw new AppError(
      "RESEARCH_UNAVAILABLE",
      current
        ? "No dated web source from the last seven days supports this current-information request. Narrow the topic, use research_topic to inspect sources, or explicitly choose timeless opinion with current_information_required=no and research_mode=off."
        : "No web evidence was found for this research-required request. Narrow the topic or explicitly choose research_mode=off for opinion.",
      true,
      {
        required_window_days: current ? 7 : null,
        web_source_count: research.evidence.filter((e) => e.kind !== "x_post")
          .length,
        dated_web_source_count: research.evidence.filter(
          (e) => e.kind !== "x_post" && e.publishedAt,
        ).length,
        research_warnings: research.warnings,
      },
    );
  return {
    research:
      !required && !hasWeb
        ? { ...research, status: "evergreen_only" as const }
        : research,
    learning,
  };
}
