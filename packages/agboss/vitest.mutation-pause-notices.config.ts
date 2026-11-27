import { defineConfig } from "vitest/config";

/**
 * The tests Stryker runs on the delivery of a pause's notices (#1356, shard `pause-notices` of `stryker.config.mjs`): the notices of a pause: their delivery, the renewal of a claim, what a restart and a crash leave. One process, no
 * nested vitest and no pods.
 */
export default defineConfig({
  test: {
    // a hang of an async test is vitest's to end (the mutant is then Killed), never Stryker's Timeout (#1367)
    testTimeout: 20_000,
    hookTimeout: 20_000,
    expect: { requireAssertions: true },
    setupFiles: ["./src/testing/setup.ts"],
    include: [
      "tests/app/pause-*.test.ts",
      "tests/app/{list-pauses,tree-end-pauses,tree-end-pauses-units}.test.ts",
      "tests/channels/*.test.ts",
      "tests/application/pause-*.test.ts",
      "tests/infrastructure/sqlite/pause-notice-atomic.test.ts",
      "tests/metrics/{pause-metrics,channel-decision-metrics}.test.ts",
      // #1356: the pause notice events
      "tests/sweep-1366h/app/pause-notice-events-1366h.test.ts",
    ],
  },
});
