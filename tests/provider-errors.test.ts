import { afterEach, expect, it, vi } from "vitest";
import { providerRequest } from "../src/providers/http";
afterEach(() => vi.restoreAllMocks());
it("identifies the provider and HTTP failure without exposing response bodies", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("secret upstream body", { status: 401 }),
  );
  await expect(
    providerRequest(
      "https://integrate.api.nvidia.com/v1/chat/completions",
      {},
      120000,
      false,
    ),
  ).rejects.toMatchObject({
    code: "PROVIDER_UNAVAILABLE",
    details: { provider: "integrate.api.nvidia.com", http_status: 401 },
    retryable: false,
  });
});
it.each([
  { error: new DOMException("secret", "TimeoutError"), failure: "timeout" },
  { error: new TypeError("secret"), failure: "network" },
])(
  "distinguishes $failure without leaking request details",
  async ({ error, failure }) => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(error);
    try {
      await providerRequest(
        "https://integrate.api.nvidia.com/v1/chat/completions",
        {},
        120000,
        false,
      );
      throw new Error("Expected rejection");
    } catch (e) {
      expect(e).toMatchObject({
        details: {
          provider: "integrate.api.nvidia.com",
          failure,
          timeout_ms: 120000,
        },
      });
      expect(String(e)).not.toContain("secret");
    }
  },
);
it("distinguishes malformed provider JSON", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not-json"));
  await expect(
    providerRequest(
      "https://integrate.api.nvidia.com/v1/chat/completions",
      {},
      120000,
      false,
    ),
  ).rejects.toMatchObject({ details: { failure: "invalid_json" } });
});
it("redacts NVIDIA authorization values from transport diagnostics", async () => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(
    new TypeError("Invalid Bearer private-api-key header: private-api-key"),
  );
  await expect(
    providerRequest(
      "https://integrate.api.nvidia.com/v1/chat/completions",
      { headers: { Authorization: "Bearer private-api-key" } },
      120000,
      false,
    ),
  ).rejects.toMatchObject({
    details: { transport_cause: "Invalid [redacted] header: [redacted]" },
  });
});
it("uses Worker-compatible manual redirect handling and rejects redirects without following them", async () => {
  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { Location: "https://other.example/steal" },
      }),
    );
  await expect(
    providerRequest(
      "https://integrate.api.nvidia.com/v1/chat/completions",
      { headers: { Authorization: "Bearer private-api-key" } },
      120000,
      false,
    ),
  ).rejects.toMatchObject({ details: { http_status: 302 } });
  expect(spy).toHaveBeenCalledTimes(1);
  expect(spy.mock.calls[0][1]?.redirect).toBe("manual");
});
