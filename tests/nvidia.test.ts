import { env } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { OpenAIProvider, objectSchema } from "../src/providers/openai";
afterEach(() => vi.restoreAllMocks());
const schema = z.object({ text: z.string() });
const jsonSchema = objectSchema({ text: { type: "string" } });
const provider = (model = "z-ai/glm-5.3-flash") =>
  new OpenAIProvider({
    ...env,
    MODEL_PROVIDER: "nvidia",
    NVIDIA_API_KEY: "test-nvidia",
    NVIDIA_MODEL: model,
  });
it("uses NVIDIA chat completions and validates final content rather than reasoning", async () => {
  const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: '{"text":"A post"}',
            reasoning_content: "private reasoning",
          },
        },
      ],
    }),
  );
  expect(
    await provider().structured("draft", schema, jsonSchema, "Write", {
      topic: "Tools",
    }),
  ).toEqual({ text: "A post" });
  expect(spy.mock.calls[0][0]).toBe(
    "https://integrate.api.nvidia.com/v1/chat/completions",
  );
  expect(new Headers(spy.mock.calls[0][1]?.headers).get("Authorization")).toBe(
    "Bearer test-nvidia",
  );
  const body = JSON.parse(String(spy.mock.calls[0][1]?.body));
  expect(body).toMatchObject({ model: "z-ai/glm-5.3-flash", stream: false });
  expect(body.messages[0].content).toContain(JSON.stringify(jsonSchema));
});
it.each([
  { finish_reason: "length", content: '{"text":"truncated"}' },
  { finish_reason: "stop", content: '{"wrong":true}' },
])("rejects incomplete or invalid results: %s", async (result) => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      choices: [
        {
          finish_reason: result.finish_reason,
          message: { content: result.content },
        },
      ],
    }),
  );
  await expect(
    provider().structured("draft", schema, jsonSchema, "Write", {}),
  ).rejects.toMatchObject({ code: "GENERATION_FAILED" });
});

it("uses Nemotron with thinking disabled for bounded structured post generation", async () => {
  const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      choices: [
        { finish_reason: "stop", message: { content: '{"text":"A post"}' } },
      ],
    }),
  );
  await provider("nvidia/nemotron-3-ultra-550b-a55b").structured(
    "draft",
    schema,
    jsonSchema,
    "Write",
    {},
  );
  expect(JSON.parse(String(spy.mock.calls[0][1]?.body))).toMatchObject({
    model: "nvidia/nemotron-3-ultra-550b-a55b",
    chat_template_kwargs: { enable_thinking: false },
    response_format: {
      type: "json_schema",
      json_schema: { name: "draft", strict: true, schema: jsonSchema },
    },
  });
});
