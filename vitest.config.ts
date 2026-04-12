import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      exclude: [
        "src/cli/**",
        "*.config.ts",
        "src/model/types.ts",
        "src/tools/base.ts",
        "src/tools/index.ts",
        "src/agent/core.ts",
      ],
      thresholds: {
        lines: 70,
        statements: 70,
        functions: 70,
        branches: 70,
      },
    },
  },
});
