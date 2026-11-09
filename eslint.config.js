import js from "@eslint/js";
import ts from "typescript-eslint";
export default ts.config(
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "error" },
  },
  { ignores: ["dist/**", ".wrangler/**", "node_modules/**"] },
);
