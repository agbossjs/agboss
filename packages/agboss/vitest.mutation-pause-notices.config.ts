import { defineConfig } from "vitest/config";

/**
 * The tests Stryker runs on the delivery of a pause's notices (#1356, shard `pause-notices` of `stryker.config.mjs`): the notices of a pause: their delivery, the renewal of a claim, what a restart and a crash leave. One process, no
 * nested vitest and no pods.
 */
export default defineConfig({
  test: {
    expect: { requireAssertions: true },
    setupFiles: ["./src/testing/setup.ts"],
    include: [
      "tests/app/pause-*.test.ts",
      "tests/app/{list-pauses,tree-end-pauses,tree-end-pauses-units}.test.ts",
      "tests/channels/*.test.ts",
      "tests/application/pause-*.test.ts",
      "tests/infrastructure/sqlite/pause-notice-atomic.test.ts",
      "tests/metrics/{pause-metrics,channel-decision-metrics}.test.ts",
    ],
  },
});
