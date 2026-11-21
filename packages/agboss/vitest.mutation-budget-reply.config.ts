import { defineConfig } from "vitest/config";

/**
 * The tests Stryker runs on the reading of a free-text reply against the tree's budgets (#1366, shard `budget-reply` of `stryker.config.mjs`). One process, no pods.
 */
export default defineConfig({
  test: {
    expect: { requireAssertions: true },
    setupFiles: ["./src/testing/setup.ts"],
    include: [
      "tests/app/reply-answer.test.ts",
      "tests/channels/reply-*.test.ts",
      "tests/channels/budget-reply-*.test.ts",
      "tests/app/budget-reply-*.test.ts",
    ],
  },
});
