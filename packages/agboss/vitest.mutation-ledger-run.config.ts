import { defineConfig } from "vitest/config";

/**
 * The tests Stryker runs on how a run's spend reaches the ledger and its turn (#1366, shard `ledger-run` of `stryker.config.mjs`): the run's record of its spend, a failure's record, a recovered and a resumed pass, what a paused run spent. One process, no pods.
 */
export default defineConfig({
  test: {
    // a hang of an async test is vitest's to end (the mutant is then Killed), never Stryker's Timeout (#1367)
    testTimeout: 20_000,
    hookTimeout: 20_000,
    expect: { requireAssertions: true },
    setupFiles: ["./src/testing/setup.ts"],
    include: [
      "tests/ledger.test.ts",
      "tests/usage.test.ts",
      "tests/pause.test.ts",
      "tests/interrupted-run.test.ts",
      "tests/history.test.ts",
      "tests/run/continue-agent.test.ts",
      "tests/run/continue-agent-fail-closed.test.ts",
      "tests/turns/run-terns.test.ts",
      "tests/app/stalled-pass-units.test.ts",
      "tests/index.test.ts",
      "tests/run/ledger-run-continue.test.ts",
      "tests/run/ledger-run-pass.test.ts",
      "tests/run/ledger-run-finish.test.ts",
    ],
  },
});
