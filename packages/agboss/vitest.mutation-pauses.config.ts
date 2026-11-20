import { defineConfig } from "vitest/config";

/**
 * The tests Stryker runs on the built-in in-memory pause store (#1356, shard `pauses` of `stryker.config.mjs`): the pause store contract on the in-memory stores (the other contracts of the conformance run take most of it and kill none of these mutants), the pause records, their orphans and wakes, the extension, reassignment, reminders and deadlines. One process, no
 * nested vitest and no pods.
 */
export default defineConfig({
  test: {
    expect: { requireAssertions: true },
    setupFiles: ["./src/testing/setup.ts"],
    // only the pause store contract of the conformance run, and every case of the other files
    testNamePattern: String.raw`paused execution contract|^(?!.*pass storeConformance)`,
    include: [
      "tests/infrastructure/store-conformance.in-memory.test.ts",
      "tests/infrastructure/{pause-rules-units,pause-mailboxes-units,pause-transitions-units,pause-store-units,pause-mailbox-store-units,recovery-log-repair,orphan-pauses,orphan-wakes,pause-record-kind,stored-pause-reading,recovery-wake-order}.test.ts",
      "tests/app/pause-{closed-error,expiry-*,extension,reassignment*,reminders,working-time}.test.ts",
      "tests/app/{tree-end-pauses,tree-end-pauses-units,list-pauses,pause-answer-log}.test.ts",
      "tests/metrics/pause-metrics.test.ts",
    ],
  },
});
