import { defineConfig } from "vitest/config";

/**
 * The tests Stryker runs on spend (#1356, shard `spend` of `stryker.config.mjs`): the budgets and
 * their rules, the usage records and their multiset key, the cost of a call and a service, the usage
 * a checkpoint restores and a response reports, the spend of a queued child. One process, no nested
 * vitest and no pods.
 */
export default defineConfig({
  test: {
    // a hang of an async test is vitest's to end (the mutant is then Killed), never Stryker's Timeout (#1367)
    testTimeout: 20_000,
    hookTimeout: 20_000,
    expect: { requireAssertions: true },
    setupFiles: ["./src/testing/setup.ts"],
    include: [
      "tests/budgets/*.test.ts",
      "tests/finops/*.test.ts",
      "tests/{ledger,usage,record-stream}.test.ts",
      "tests/models/{cost,usage-contract}.test.ts",
      "tests/models/streaming/*usage*.test.ts",
      "tests/app/{restored-usage,router-spend,pause-extension,pause-expiry-log-levels,queued-child-spend-units}.test.ts",
      "tests/app/remote-child-*.test.ts",
      "tests/flow/context/spend.test.ts",
      "tests/flow/runtime/{child-limits,remote-limits}.test.ts",
      "tests/components/{accounted-router,decision-model}.test.ts",
      "tests/properties/budget-meter.property.test.ts",
      "tests/channels/paused-spend.test.ts",
      "tests/run/*.test.ts",
      // a trusted caller's budget, and the frame a custom compaction reads before the first step
      "tests/mcp/mcp-mesh-trust.test.ts",
      "tests/memory/custom-compaction.test.ts",
      // #1356: the budget's spend in the shelves
      "tests/config/shelves.test.ts",
    ],
  },
});
