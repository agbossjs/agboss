import { defineConfig } from "vitest/config";

/**
 * The tests Stryker runs on the spend of one branch of a launch (#1366, shard `ledger-branch` of `stryker.config.mjs`). One process, no pods.
 */
export default defineConfig({
  test: {
    expect: { requireAssertions: true },
    setupFiles: ["./src/testing/setup.ts"],
    include: [
      "tests/flow/runtime/launch*.test.ts",
      "tests/flow/runtime/quorum*.test.ts",
      "tests/flow/runtime/{arbiters,router-launch,join-notices,join-keys}.test.ts",
      "tests/budgets/{parallel-budget,lost-pass}.test.ts",
      "tests/flow/runtime/ledger-branch-units.test.ts",
    ],
  },
});
