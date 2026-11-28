import { defineConfig } from "vitest/config";

/**
 * The tests Stryker runs on a child execution counted once (#1366, shard `once-child` of
 * `stryker.config.mjs`): a child's step in its parent, a child on any instance as its parent's step waits
 * for it, the queued child's pass on its worker and the end its worker announces. One process, no pods.
 */
export default defineConfig({
  test: {
    // a hang of an async test is vitest's to end (the mutant is then Killed), never Stryker's Timeout (#1367)
    testTimeout: 20_000,
    hookTimeout: 20_000,
    expect: { requireAssertions: true },
    setupFiles: ["./src/testing/setup.ts"],
    include: [
      "tests/app/{queued-child-streamed,child-end-event.units}.test.ts",
      "tests/app/{child-end-once,child-failure-once,finished-child-claim,remote-child-wake,remote-child-yield,child-claim-room,child-lease-refused,child-queue-wake}.test.ts",
      "tests/flow/runtime/child*.test.ts",
      "tests/flow/runtime/remote-children*.test.ts",
      "tests/flow/runtime/remote-child-end.units.test.ts",
      "tests/budgets/remote-child-marks.test.ts",
      "tests/pii/chain-remote.test.ts",
      // #1356: the claim timeout of an OtherWorker child
      "tests/flow/runtime/other-worker.test.ts",
    ],
  },
});
