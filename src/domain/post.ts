import twitter from "twitter-text";
export const RUBRIC = "rubric-1.0";
export const dimensions = {
  relevance: 20,
  hook: 20,
  clarity: 15,
  value: 20,
  shareability: 15,
  discussion: 10,
} as const;
export function validatePost(
  text: string,
  constraints: { must_include: string[]; avoid: string[] },
) {
  const parsed = twitter.parseTweet(text);
  const lower = text.toLowerCase();
  return {
    weighted_characters: parsed.weightedLength,
    length: parsed.valid && parsed.weightedLength <= 280,
    constraints:
      constraints.must_include.every((s) => lower.includes(s.toLowerCase())) &&
      constraints.avoid.every((s) => !lower.includes(s.toLowerCase())),
  };
}
export function features(text: string) {
  const first = text.split("\n")[0];
  return {
    version: "features-1.0",
    format: "single",
    hook: /\?/.test(first)
      ? "question"
      : /\b(stop|wrong|don.t|isn.t)\b/i.test(first)
        ? "contrarian"
        : "observation",
    length_band:
      twitter.parseTweet(text).weightedLength <= 140 ? "short" : "standard",
    line_breaks: text.split("\n").length - 1,
    links: twitter.extractUrls(text).length,
  };
}
export function parseXId(value: string) {
  if (/^\d{5,25}$/.test(value)) return value;
  try {
    const u = new URL(value);
    if (
      u.protocol !== "https:" ||
      !["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(
        u.hostname,
      ) ||
      u.username ||
      u.password
    )
      return null;
    return /^\/[^/]+\/status\/(\d{5,25})\/?$/.exec(u.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}
export const metricKeys = [
  "impressions",
  "likes",
  "replies",
  "reposts",
  "quotes",
  "bookmarks",
  "clicks",
  "views",
] as const;
export type Metrics = Record<(typeof metricKeys)[number], number | null>;
export function normalizeMetrics(raw: Record<string, unknown>): Metrics {
  // Provider's comments/shares/saves correspond to X replies/reposts/bookmarks.
  const aliases: Record<string, string> = {
    replies: "comments",
    reposts: "shares",
    bookmarks: "saves",
  };
  return Object.fromEntries(
    metricKeys.map((k) => {
      const v = raw[k] ?? raw[aliases[k]];
      return [
        k,
        typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null,
      ];
    }),
  ) as Metrics;
}
export function rates(m: Metrics): Record<string, number | null> {
  const available = ["likes", "replies", "reposts", "quotes"].filter(
    (k) => m[k as keyof Metrics] !== null,
  );
  const result: Record<string, number | null> = {
    observed_interaction_rate: null,
  };
  if (!m.impressions || available.length === 0) return result;
  const rate =
    available.reduce((n, k) => n + m[k as keyof Metrics]!, 0) / m.impressions;
  result[
    available.length === 4
      ? "observed_interaction_rate"
      : `${available.map((k) => ({ likes: "like", replies: "reply", reposts: "repost", quotes: "quote" })[k]).join("_")}_rate`
  ] = rate;
  return result;
}
