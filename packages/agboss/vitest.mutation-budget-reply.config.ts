import { defineConfig } from "vitest/config";

/**
 * The tests Stryker runs on the reading of a free-text reply against the tree's budgets (#1366, shard `budget-reply` of `stryker.config.mjs`). One process, no pods.
 */
export default defineConfig({
  test: {
    // a hang of an async test is vitest's to end (the mutant is then Killed), never Stryker's Timeout (#1367)
    testTimeout: 20_000,
    hookTimeout: 20_000,
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
