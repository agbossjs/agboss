import { defineConfig } from "vitest/config";

/**
 * The tests Stryker runs on an agent's loop and its budgets (#1366, shard `budget-loop` of `stryker.config.mjs`): the checks around a model call, the limits, the exhausted signal, the spend counted at once. One process, no pods.
 */
export default defineConfig({
  test: {
    expect: { requireAssertions: true },
    setupFiles: ["./src/testing/setup.ts"],
    include: [
      "tests/budgets/**/*.test.ts",
      "tests/graph/**/*.test.ts",
      "tests/graph/budget-loop-*.test.ts",
    ],
  },
});
