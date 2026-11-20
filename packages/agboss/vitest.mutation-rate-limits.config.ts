import { defineConfig } from "vitest/config";

/**
 * The tests Stryker runs on the built-in rate limit stores (#1356, shard `rate-limits` of `stryker.config.mjs`): the rate limit contract on both stores, the policy and the 429 backoff, the table's migration. One process, no
 * nested vitest and no pods.
 */
export default defineConfig({
  test: {
    expect: { requireAssertions: true },
    setupFiles: ["./src/testing/setup.ts"],
    // only the rate limit contract of the conformance run, and every case of the other files
    testNamePattern: String.raw`rate limit contract|^(?!.*pass storeConformance)`,
    include: [
      "tests/infrastructure/store-conformance.in-memory.test.ts",
      "tests/infrastructure/store-conformance.sqlite.test.ts",
      "tests/models/{rate-limit,rate-limit-429,rate-limit-policy}.test.ts",
      "tests/infrastructure/rate-limit-units.test.ts",
      "tests/infrastructure/sqlite/sqlite-rate-limit-migration.test.ts",
    ],
  },
});
