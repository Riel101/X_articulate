import type { Env } from "../config/env";
import { AppError } from "../domain/errors";
import { normalizeMetrics } from "../domain/post";
import { array, providerRequest, record, string } from "./http";
export class ZernioProvider {
  constructor(private env: Env) {}
  private get headers() {
    if (!this.env.ZERNIO_API_KEY || !this.env.ZERNIO_ACCOUNT_ID)
      throw new AppError(
        "FORBIDDEN",
        "Configure Zernio credentials and an authorized connected account.",
      );
    return {
      Authorization: `Bearer ${this.env.ZERNIO_API_KEY}`,
      "Content-Type": "application/json",
    };
  }
  async verify(postId: string) {
    const { status, data } = await providerRequest(
      "https://zernio.com/api/v1/posts/sync-external",
      {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({ accountId: this.env.ZERNIO_ACCOUNT_ID, postId }),
      },
      15000,
      false,
    );
    const root = record(data);
    const post = record(root.post);
    if (
      status !== 200 ||
      root.found !== true ||
      string(post.platformPostId) !== postId ||
      post.platform !== "twitter"
    )
      throw new AppError(
        "POST_NOT_LINKED",
        "The post could not be verified on your connected X account. Check the ID, account connection, and sync availability.",
        true,
      );
    const text = string(post.content);
    const publishedAt = string(post.publishedAt);
    if (
      !text ||
      !Number.isFinite(Date.parse(publishedAt)) ||
      Date.parse(publishedAt) > Date.now() + 60000
    )
      throw new AppError(
        "POST_NOT_LINKED",
        "Provider did not return valid published text and publication time.",
        true,
      );
    return {
      text,
      publishedAt: new Date(publishedAt).toISOString(),
      providerId: string(post.id) || postId,
    };
  }
  async metrics(postId: string, xId: string, publishedAt?: string) {
    const url = new URL("https://zernio.com/api/v1/analytics");
    url.search = new URLSearchParams({
      postId,
      accountId: this.env.ZERNIO_ACCOUNT_ID!,
      platform: "twitter",
    }).toString();
    let { status, data } = await providerRequest(url.toString(), {
      headers: this.headers,
    });
    // External sync returns a native X ID, while analytics documents internal
    // ExternalPost IDs. Resolve a native-ID miss through a bounded account list.
    if (status === 404 && publishedAt) {
      const day = publishedAt.slice(0, 10);
      for (let page = 1; page <= 2; page++) {
        const list = new URL("https://zernio.com/api/v1/analytics");
        list.search = new URLSearchParams({
          accountId: this.env.ZERNIO_ACCOUNT_ID!,
          platform: "twitter",
          source: "external",
          fromDate: day,
          toDate: day,
          limit: "100",
          page: String(page),
        }).toString();
        const response = await providerRequest(list.toString(), {
          headers: this.headers,
        });
        const posts = array(record(response.data).posts).map(record);
        const found = posts.find((p) =>
          array(p.platformAnalytics)
            .map(record)
            .some(
              (p) =>
                p.platform === "twitter" &&
                p.accountId === this.env.ZERNIO_ACCOUNT_ID &&
                p.platformPostId === xId,
            ),
        );
        if (found) {
          status = 200;
          data = found;
          break;
        }
        if (posts.length < 100) break;
      }
    }
    if (status === 202) return { status: "pending" as const };
    if (status === 404 || status === 424)
      return { status: "unavailable" as const };
    const root = record(data);
    if (root.syncStatus === "pending") return { status: "pending" as const };
    const platforms = array(root.platformAnalytics).map(record);
    const platform = platforms.find(
      (p) =>
        p.platform === "twitter" &&
        p.accountId === this.env.ZERNIO_ACCOUNT_ID &&
        p.platformPostId === xId,
    );
    if (platform?.syncStatus === "pending")
      return { status: "pending" as const };
    // Never use an aggregate across platforms/accounts, or accept a mismatched post.
    const direct =
      root.platform === "twitter" &&
      root.platformPostId === xId &&
      root.accountId === this.env.ZERNIO_ACCOUNT_ID
        ? root
        : undefined;
    const selected = platform ?? direct;
    if (
      !selected ||
      selected.syncStatus === "unavailable" ||
      !selected.analytics
    )
      return { status: "unavailable" as const };
    const raw = record(selected.analytics);
    const metrics = normalizeMetrics(raw);
    if (Object.values(metrics).every((v) => v === null))
      return { status: "unavailable" as const };
    const updated = string(raw.lastUpdated);
    return {
      status: "ok" as const,
      metrics,
      updatedAt: Number.isFinite(Date.parse(updated))
        ? new Date(updated).toISOString()
        : null,
    };
  }
}
