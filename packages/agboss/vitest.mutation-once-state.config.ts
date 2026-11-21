import { defineConfig } from "vitest/config";

/**
 * The tests Stryker runs on the channels of the two states every pass of an execution reads and writes
 * (#1366, shard `once-state` of `stryker.config.mjs`): what each channel starts as and how an update joins
 * what it holds — the spend appended, the counters added, so each call is counted once. One process.
 */
export default defineConfig({
  test: {
    // a hang of an async test is vitest's to end (the mutant is then Killed), never Stryker's Timeout (#1367)
    testTimeout: 20_000,
    hookTimeout: 20_000,
    expect: { requireAssertions: true },
    setupFiles: ["./src/testing/setup.ts"],
    include: [
      "tests/flow/runtime/state-channels.test.ts",
      "tests/graph/agent-loop/state-channels.test.ts",
    ],
  },
});
