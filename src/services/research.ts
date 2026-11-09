import type { Env } from "../config/env";
import type { ResearchResult } from "../domain/contracts";
import { hash } from "../domain/errors";
import { defaultProviders, type ResearchProvider } from "../providers/research";
export function isCurrent(topic: string) {
  return /\b(today|latest|breaking|recent|yesterday|this (week|month)|announced|announcement|launched|202[6-9])\b/i.test(
    topic,
  );
}
export class ResearchOrchestrator {
  constructor(
    private env: Env,
    private providers: ResearchProvider[] = defaultProviders(env),
  ) {}
  async research(
    topic: string,
    freshness = "auto",
    max = 5,
  ): Promise<ResearchResult> {
    const recent =
      freshness === "recent" || (freshness === "auto" && isCurrent(topic));
    const warnings: string[] = [];
    const used: string[] = [];
    const batches = await Promise.all(
      this.providers.map(async (p) => {
        try {
          const ttl = recent ? 900 : 86400;
          const key = `research:v2:${await hash(JSON.stringify([p.id, topic.trim().toLowerCase(), recent, Math.floor(Date.now() / 1000 / ttl), p.id === "zernio" ? this.env.ZERNIO_ACCOUNT_ID : "public"]))}`;
          let cached: {
            expires: number;
            evidence: ResearchResult["evidence"];
          } | null = null;
          try {
            cached = (await this.env.RESEARCH_CACHE?.get(key, "json")) ?? null;
          } catch {
            /* Cache is optional. */
          }
          if (cached && cached.expires > Date.now()) {
            used.push(p.id);
            return cached.evidence;
          }
          const evidence = await p.search(topic, recent);
          used.push(p.id);
          try {
            await this.env.RESEARCH_CACHE?.put(
              key,
              JSON.stringify({ expires: Date.now() + ttl * 1000, evidence }),
              { expirationTtl: ttl },
            );
          } catch {
            /* Durable state is in D1. */
          }
          return evidence;
        } catch {
          warnings.push(`${p.id} research unavailable`);
          return [];
        }
      }),
    );
    const evidence = [
      ...new Map(batches.flat().map((e) => [e.url, e])).values(),
    ].slice(0, 10);
    if (!this.providers.length)
      warnings.push("No research credentials configured.");
    if (!evidence.length)
      return {
        status: recent ? "unavailable" : "evergreen_only",
        evidence: [],
        angles: [],
        warnings,
        providers_used: used,
      };
    // Search snippets are leads, never automatically corroborated facts.
    return {
      status: "partial",
      evidence,
      angles: evidence
        .filter((e) => e.kind !== "x_post")
        .slice(0, max)
        .map((e) => e.title || e.excerpt.slice(0, 100)),
      warnings: [
        ...warnings,
        "Search excerpts require claim-level verification; X posts are conversation context.",
      ],
      providers_used: used,
    };
  }
}
