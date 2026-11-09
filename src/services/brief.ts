import type { Env } from "../config/env";
import type { CreateInput } from "../domain/contracts";
import { AppError } from "../domain/errors";
import { BankRepository } from "../repositories/bank";
import { ResearchOrchestrator } from "./research";
export async function loadContext(
  env: Env,
  bank: BankRepository,
  input: CreateInput,
) {
  const [research, learning] = await Promise.all([
    new ResearchOrchestrator(env).research(
      input.topic,
      input.current_information_required === "yes"
        ? "recent"
        : input.current_information_required === "no"
          ? "evergreen"
          : "auto",
    ),
    bank.insights(input.topic, input.audience),
  ]);
  if (research.status === "unavailable")
    throw new AppError(
      "RESEARCH_UNAVAILABLE",
      "Current information could not be researched. Retry when a research provider is available.",
      true,
    );
  if (
    input.current_information_required === "yes" &&
    !research.evidence.some(
      (e) =>
        e.kind === "web" &&
        e.publishedAt &&
        Date.now() - Date.parse(e.publishedAt) >= 0 &&
        Date.now() - Date.parse(e.publishedAt) < 7 * 86400000,
    )
  )
    throw new AppError(
      "RESEARCH_UNAVAILABLE",
      "No dated web evidence supports a current-information post. Retry with a narrower topic.",
      true,
    );
  return { research, learning };
}
