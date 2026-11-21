import { defineConfig } from "vitest/config";

/**
 * The tests Stryker runs on the built-in rate limit stores (#1356, shard `rate-limits` of `stryker.config.mjs`): the rate limit contract on both stores, the policy and the 429 backoff, the table's migration. One process, no
 * nested vitest and no pods.
 */
export default defineConfig({
  test: {
    // a hang of an async test is vitest's to end (the mutant is then Killed), never Stryker's Timeout (#1367)
    testTimeout: 20_000,
    hookTimeout: 20_000,
    expect: { requireAssertions: true },
    setupFiles: ["./src/testing/setup.ts"],
    include: [
      "tests/infrastructure/store-conformance.in-memory.test.ts",
      "tests/infrastructure/store-conformance.sqlite.test.ts",
      "tests/models/{rate-limit,rate-limit-429,rate-limit-policy}.test.ts",
      "tests/infrastructure/rate-limit-units.test.ts",
      "tests/infrastructure/sqlite/sqlite-rate-limit-migration.test.ts",
    ],
  },
});
