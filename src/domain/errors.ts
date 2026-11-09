export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public retryable = false,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
export function errorResult(error: unknown, requestId: string) {
  const e =
    error instanceof AppError
      ? error
      : new AppError(
          "INTERNAL_ERROR",
          "The request could not be completed. Retry with the request ID.",
          true,
        );
  return {
    code: e.code,
    message: e.message,
    retryable: e.retryable,
    request_id: requestId,
    details: e.details,
  };
}
export const id = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;
export async function hash(text: string) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(bytes)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
