import { defineConfig } from "vitest/config";

/**
 * The tests Stryker runs on the runs a cancel aborts, a branch's end and the remote task's wait (#1366, shard `cancel-x-runs` of `stryker.config.mjs`).
 * One process, no nested vitest and no pods.
 */
export default defineConfig({
  test: {
    // a hang of an async test is vitest's to end (the mutant is then Killed), never Stryker's Timeout (#1367)
    testTimeout: 20_000,
    hookTimeout: 20_000,
    expect: { requireAssertions: true },
    setupFiles: ["./src/testing/setup.ts"],
    include: [
      "tests/app/cancel-x-runs-units.test.ts",
      "tests/a2a/client/a2a-waiter-units.test.ts",
      "tests/flow/runtime/cancel-x-branch-end-units.test.ts",
    ],
  },
});
