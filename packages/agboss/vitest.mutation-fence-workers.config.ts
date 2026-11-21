import { defineConfig } from "vitest/config";

/**
 * The tests Stryker runs on the queued children's workers and the lease and slots of a step (#1366, shard `fence-workers` of `stryker.config.mjs`).
 * One process, no nested vitest and no pods.
 */
export default defineConfig({
  test: {
    expect: { requireAssertions: true },
    setupFiles: ["./src/testing/setup.ts"],
    include: [
      "tests/app/fence-workers-units.test.ts",
      "tests/app/fence-child-workers-units.test.ts",
      "tests/app/{child-claim-room,child-end-once,child-failure-once,child-lease-refused,child-queue-wake,finished-child-claim,lost-claim-reclaim,remote-child-wake,remote-child-yield}.test.ts",
    ],
  },
});
