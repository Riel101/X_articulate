import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
          MCP_AUTH_TOKEN: "test-token-with-at-least-32-characters",
          MCP_OWNER_ID: "owner_test",
          MCP_ALLOWED_ORIGINS: "https://agent.example",
          MCP_PUBLIC_URL: "https://localhost/mcp",
          OPENAI_MODEL: "test-model",
          OPENAI_API_KEY: "test-key",
          ZERNIO_API_KEY: "test-zernio",
          ZERNIO_ACCOUNT_ID: "z-account",
          X_USERNAME: "tester",
        },
      },
    }),
  ],
  test: { setupFiles: ["./tests/setup.ts"] },
}));
