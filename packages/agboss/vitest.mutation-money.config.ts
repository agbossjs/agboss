import { defineConfig } from "vitest/config";

/**
 * The tests Stryker runs on money (#633, shard `money` of `stryker.config.mjs`): the budgets, the
 * meter's property, spend counted once across instances and takeovers, the cost ledger contract on
 * both ledgers. One process, no nested vitest and no pods.
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
      "tests/ledger.test.ts",
      "tests/properties/budget-meter.property.test.ts",
      "tests/isolation/concurrent-budgets.test.ts",
      "tests/infrastructure/{cost-ledger-stores,cost-ledger-keys,sqlite/sqlite-cost-ledger}.test.ts",
      "tests/channels/paused-spend.test.ts",
      "tests/flow/runtime/{child-limits,remote-limits}.test.ts",
      "tests/flow/context/spend.test.ts",
    ],
  },
});
