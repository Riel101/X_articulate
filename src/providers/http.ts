import { AppError } from "../domain/errors";
export async function providerRequest(
  url: string,
  init: RequestInit,
  timeoutMs = 12000,
  retry = true,
): Promise<{ status: number; data: unknown }> {
  for (let attempt = 0; attempt < (retry ? 2 : 1); attempt++) {
    try {
      const response = await fetch(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (
        (response.status === 429 || response.status >= 500) &&
        attempt === 0 &&
        retry
      ) {
        await response.body?.cancel();
        await new Promise((resolve) =>
          setTimeout(resolve, 150 + Math.random() * 200),
        );
        continue;
      }
      if ([202, 404, 424].includes(response.status)) {
        await response.body?.cancel();
        return { status: response.status, data: null };
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new AppError(
          response.status === 429 ? "RATE_LIMITED" : "PROVIDER_UNAVAILABLE",
          "A provider rejected the request. Check server credentials, permissions, and quota.",
          response.status === 429 || response.status >= 500,
        );
      }
      // Bound response bytes before JSON parsing.
      const reader = response.body?.getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];
      if (reader) {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 1_000_000) {
            await reader.cancel();
            throw new AppError(
              "PROVIDER_UNAVAILABLE",
              "Provider response exceeded the size limit.",
            );
          }
          chunks.push(value);
        }
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return {
        status: response.status,
        data: JSON.parse(new TextDecoder().decode(bytes)),
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (attempt === (retry ? 1 : 0))
        throw new AppError(
          "PROVIDER_UNAVAILABLE",
          "Provider timed out or returned an invalid response.",
          true,
        );
    }
  }
  throw new AppError("PROVIDER_UNAVAILABLE", "Provider unavailable.", true);
}
export const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
export const array = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const string = (v: unknown): string => (typeof v === "string" ? v : "");
export function safeUrl(value: unknown): string | null {
  try {
    const u = new URL(string(value));
    if (u.protocol !== "https:" || u.username || u.password) return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}
export function cleanExcerpt(value: unknown) {
  return string(value)
    .replace(/<[^>]*>/g, " ")
    .split(/[\r\n]+/)
    .filter(
      (line) =>
        !/ignore.{0,40}(instructions|previous)|system\s*prompt|api[_ -]?key|reveal.{0,30}secret|<\|/i.test(
          line,
        ),
    )
    .join(" ")
    .slice(0, 650);
}
