import { defineConfig } from "vitest/config";

/**
 * The tests Stryker runs on the store-call bound (#1069, shard `store-bound` of
 * `stryker.config.mjs`): the bound and its settling on every path, the outcome classification, the
 * iterator and command-timeout bounds, SQLite's unknown outcomes, the lease's renewal margin,
 * abandon, scope and release after the end. One process, no nested vitest and no pods.
 */
export default defineConfig({
  test: {
    expect: { requireAssertions: true },
    setupFiles: ["./src/testing/setup.ts"],
    include: [
      "tests/app/{store-call-*,lease-renewal-margin,lease-release-after-end,lease-scope-*,held-lease-abandon*}.test.ts",
      "tests/infrastructure/sqlite/sqlite-outcome*.test.ts",
    ],
  },
});
