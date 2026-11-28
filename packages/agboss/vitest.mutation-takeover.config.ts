import { defineConfig } from "vitest/config";

/**
 * The tests Stryker runs on takeover and recovery (#633, shards `takeover` and `recovery` of
 * `stryker.config.mjs`): the leases' yields, attempts, takes and moves, finished work, an end heard
 * once, the recovery sweep and an undo a takeover finishes. One process, no nested vitest and no
 * pods.
 */
export default defineConfig({
  test: {
    // a hang of an async test is vitest's to end (the mutant is then Killed), never Stryker's Timeout (#1367)
    testTimeout: 20_000,
    hookTimeout: 20_000,
    expect: { requireAssertions: true },
    setupFiles: ["./src/testing/setup.ts"],
    include: [
      "tests/app/{lease-*,held-lease*,tree-moves-units,recover-root-units,tree-ends-units,ended-tree-units,finished-*,*end-once*,remote-child-yield,execution-fence*,compensation-recovery*,kept-undo-takeover,hand-over-records,cancel*,resume-across-deployments,child-failure-once,close-waits-for-steps,pause-withdrawals,zombie-evidence,undo-fence}.test.ts",
      "tests/infrastructure/{lease-*,execution-lease-*-bites,recovery*,concurrent-resume}.test.ts",
      "tests/budgets/{exemption-takeover,spend-once-takeover}.test.ts",
      // #860: a run no recovery continues, and its lost pass's call of unknown cost (D1)
      "tests/app/{without-recovery,lost-attempt}.test.ts",
      // #1307: a Date fact of an error is an ISO text in its details
      "tests/core/error-details-dates.test.ts",
      // #1090: a new run handed over before its first checkpoint, and after it
      "tests/app/{first-checkpoint-hand-over,writes-window-takeover}.test.ts",
      // #1098: a tree lost in the writes window at an answer — a waiting resume, an own-thread child
      "tests/app/writes-window-{resume,pauses}.test.ts",
      // #1187: the drain's mark before it takes an answer, the wake of a paused root beside one
      "tests/app/{drain-rest-mark,answered-wake-units}.test.ts",
      // #1356: the wake of a parked root an `app.unpause` died on
      "tests/app/parked-wake-units.test.ts",
      // #1090: a new run handed over before its first checkpoint write is told it did not start
      "tests/app/unstarted-run-units.test.ts",
      // #1356: how a drained tree stands in its kept record
      "tests/app/tree-drain-units.test.ts",
      // #1179: the pass of a tree left mid-pass, its waiting check pinned on its own
      "tests/app/stalled-pass-units.test.ts",
      "tests/infrastructure/{orphan-pauses,orphan-wakes,recovery-wake-order}.test.ts",
      // #1325a: the hand-over kinds and records, the families' classes and how a class is caught
      "tests/errors/{family-routing,error-families,error-record-families,cancel-fenced,family-machinery-units,hand-over-records}.test.ts",
      // #1356: the stop marks and the lease that stops, where they are tested
      "tests/infrastructure/finish-over-mark.test.ts",
      "tests/infrastructure/pause-fence-units.test.ts",
      "tests/app/child-pause-watch-units.test.ts",
      // an operator's pause, its lift and a stop (#1341), end to end through the public calls
      "tests/app/pause.test.ts",
      "tests/app/unpause-after-answered-park.test.ts",
      "tests/app/stop-across-instances.test.ts",
    ],
  },
});
