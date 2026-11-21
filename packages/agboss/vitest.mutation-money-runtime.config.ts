import { defineConfig } from "vitest/config";

/**
 * The tests Stryker runs on the money rules of the flow runtime (#1356, shard `money-runtime` of
 * `stryker.config.mjs`): which visits the budgets check, a service's and a router's spend counted at once, a
 * child's own spend and its failure, the ledger ids of lost passes, the spend a failure carries and a paused
 * run's spend. One process, no nested vitest and no pods.
 */
export default defineConfig({
  test: {
    // a hang of an async test is vitest's to end (the mutant is then Killed), never Stryker's Timeout (#1367)
    testTimeout: 20_000,
    hookTimeout: 20_000,
    expect: { requireAssertions: true },
    setupFiles: ["./src/testing/setup.ts"],
    include: [
      "tests/flow/runtime/money-runtime-units.test.ts",
      // a limit that is no count is a bound of 0 (#1373)
      "tests/graph/count-limit.test.ts",
      "tests/flow/runtime/money-runtime-spend-units.test.ts",
      "tests/errors/recorded-error.test.ts",
      "tests/finops/lost-passes.test.ts",
    ],
  },
});
