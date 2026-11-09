import type { Env } from "../config/env";
import type { Evidence } from "../domain/contracts";
import { hash } from "../domain/errors";
import {
  array,
  cleanExcerpt,
  providerRequest,
  record,
  safeUrl,
  string,
} from "./http";
export interface ResearchProvider {
  id: string;
  supports(kind: Evidence["kind"]): boolean;
  search(query: string, recent: boolean): Promise<Evidence[]>;
}
export class TavilyProvider implements ResearchProvider {
  id = "tavily";
  constructor(private env: Env) {}
  supports(kind: Evidence["kind"]) {
    return kind === "web";
  }
  async search(query: string, recent: boolean) {
    const { data } = await providerRequest("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.env.TAVILY_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        search_depth: "basic",
        max_results: 5,
        include_answer: false,
        include_raw_content: false,
        ...(recent ? { topic: "news", days: 7, time_range: "week" } : {}),
      }),
    });
    const evidence: Evidence[] = [];
    for (const item of array(record(data).results)) {
      const r = record(item);
      const url = safeUrl(r.url);
      if (!url) continue;
      evidence.push({
        id: await hash(url),
        kind: "web",
        provider: this.id,
        title: string(r.title).slice(0, 200),
        url,
        excerpt: cleanExcerpt(r.content),
        retrievedAt: new Date().toISOString(),
        ...(string(r.published_date) &&
        Number.isFinite(Date.parse(string(r.published_date)))
          ? { publishedAt: new Date(string(r.published_date)).toISOString() }
          : {}),
        claims: [],
        verification: "single_source",
      });
    }
    return evidence;
  }
}
export class ZernioResearchProvider implements ResearchProvider {
  id = "zernio";
  constructor(private env: Env) {}
  supports(kind: Evidence["kind"]) {
    return kind === "x_post";
  }
  async search(query: string) {
    const url = new URL("https://zernio.com/api/v1/twitter/search");
    url.search = new URLSearchParams({
      accountId: this.env.ZERNIO_ACCOUNT_ID!,
      query: query.slice(0, 512),
      limit: "10",
      sortOrder: "relevancy",
    }).toString();
    const { data } = await providerRequest(url.toString(), {
      headers: { Authorization: `Bearer ${this.env.ZERNIO_API_KEY}` },
    });
    const evidence: Evidence[] = [];
    for (const item of array(record(data).tweets).slice(0, 5)) {
      const r = record(item);
      const postId = string(r.id);
      if (!/^\d+$/.test(postId)) continue;
      const author = string(record(r.author).username);
      const url = `https://x.com/${author || "i"}/status/${postId}`;
      evidence.push({
        id: await hash(url),
        kind: "x_post",
        provider: this.id,
        url,
        author,
        excerpt: cleanExcerpt(r.text),
        retrievedAt: new Date().toISOString(),
        ...(string(r.createdAt || r.created_at)
          ? { publishedAt: string(r.createdAt || r.created_at) }
          : {}),
        claims: [],
        verification: "unverified",
      });
    }
    return evidence;
  }
}
export function defaultProviders(env: Env): ResearchProvider[] {
  return [
    ...(env.TAVILY_API_KEY ? [new TavilyProvider(env)] : []),
    ...(env.ZERNIO_API_KEY && env.ZERNIO_ACCOUNT_ID
      ? [new ZernioResearchProvider(env)]
      : []),
  ];
}
