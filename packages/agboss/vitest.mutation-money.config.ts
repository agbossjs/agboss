import { defineConfig } from "vitest/config";

/**
 * The tests Stryker runs on money (#633, shard `money` of `stryker.config.mjs`): the budgets, the
 * meter's property, spend counted once across instances and takeovers, the cost ledger contract on
 * both ledgers. One process, no nested vitest and no pods.
 */
export default defineConfig({
  test: {
    expect: { requireAssertions: true },
    setupFiles: ["./src/testing/setup.ts"],
    include: [
      "tests/budgets/*.test.ts",
      "tests/ledger.test.ts",
      "tests/properties/budget-meter.property.test.ts",
      "tests/isolation/concurrent-budgets.test.ts",
      "tests/infrastructure/{cost-ledger-stores,sqlite/sqlite-cost-ledger}.test.ts",
      "tests/channels/paused-spend.test.ts",
      "tests/flow/runtime/{child-limits,remote-limits}.test.ts",
      "tests/flow/context/spend.test.ts",
    ],
  },
});
