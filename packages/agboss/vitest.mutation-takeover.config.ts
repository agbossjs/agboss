import { defineConfig } from "vitest/config";

/**
 * The tests Stryker runs on takeover and recovery (#633, shards `takeover` and `recovery` of
 * `stryker.config.mjs`): the leases' yields, attempts, takes and moves, finished work, an end heard
 * once, the recovery sweep and an undo a takeover finishes. One process, no nested vitest and no
 * pods.
 */
export default defineConfig({
  test: {
    expect: { requireAssertions: true },
    setupFiles: ["./src/testing/setup.ts"],
    include: [
      "tests/app/{lease-*,held-lease*,tree-moves-units,recover-root-units,tree-ends-units,ended-tree-units,finished-*,*end-once*,remote-child-yield,execution-fence*,compensation-recovery*,kept-undo-takeover,hand-over-records,cancel*,resume-across-deployments,child-failure-once,close-waits-for-steps,pause-withdrawals,zombie-evidence,undo-fence}.test.ts",
      "tests/infrastructure/{lease-*,execution-lease-*-bites,recovery*,concurrent-resume}.test.ts",
      "tests/budgets/{exemption-takeover,spend-once-takeover}.test.ts",
      // #860: a run no recovery continues, and its lost pass's call of unknown cost (D1)
      "tests/app/{without-recovery,lost-attempt}.test.ts",
    ],
  },
});
