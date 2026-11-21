import { defineConfig } from "vitest/config";

/**
 * The tests Stryker runs on the flow's visits and launches against the budgets (#1366, shard `budget-flow` of `stryker.config.mjs`). One process, no pods.
 */
export default defineConfig({
  test: {
    expect: { requireAssertions: true },
    setupFiles: ["./src/testing/setup.ts"],
    include: ["tests/budgets/**/*.test.ts", "tests/flow/runtime/budget-flow-*.test.ts"],
  },
});
