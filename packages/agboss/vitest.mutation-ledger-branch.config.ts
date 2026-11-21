import { defineConfig } from "vitest/config";

/**
 * The tests Stryker runs on the spend of one branch of a launch (#1366, shard `ledger-branch` of `stryker.config.mjs`). One process, no pods.
 */
export default defineConfig({
  test: {
    // a hang of an async test is vitest's to end (the mutant is then Killed), never Stryker's Timeout (#1367)
    testTimeout: 20_000,
    hookTimeout: 20_000,
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
