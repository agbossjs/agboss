import { defineConfig } from "vitest/config";

/**
 * The tests Stryker runs on an agent's loop and its budgets (#1366, shard `budget-loop` of `stryker.config.mjs`): the checks around a model call, the limits, the exhausted signal, the spend counted at once. One process, no pods.
 */
export default defineConfig({
  test: {
    // a hang of an async test is vitest's to end (the mutant is then Killed), never Stryker's Timeout (#1367)
    testTimeout: 20_000,
    hookTimeout: 20_000,
    expect: { requireAssertions: true },
    setupFiles: ["./src/testing/setup.ts"],
    include: [
      "tests/budgets/**/*.test.ts",
      "tests/graph/**/*.test.ts",
      "tests/graph/budget-loop-*.test.ts",
      // #1356: a tool's output over the inline cap
      "tests/files/inline-cap-poison-1316c.test.ts",
    ],
  },
});
