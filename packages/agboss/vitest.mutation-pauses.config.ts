import { defineConfig } from "vitest/config";

/**
 * The tests Stryker runs on the built-in in-memory pause store (#1356, shard `pauses` of `stryker.config.mjs`): the pause store contract on the in-memory stores (the other contracts of the conformance run take most of it and kill none of these mutants), the pause records, their orphans and wakes, the extension, reassignment, reminders and deadlines. One process, no
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
      "tests/infrastructure/store-conformance.in-memory.test.ts",
      "tests/infrastructure/{pause-rules-units,pause-limits-stored,pause-mailboxes-units,pause-transitions-units,pause-reassign-transition-units,pause-store-units,pause-mailbox-store-units,recovery-log-repair,orphan-pauses,orphan-wakes,pause-record-kind,stored-pause-reading,recovery-wake-order}.test.ts",
      "tests/app/pause-{closed-error,decide-stale,expiry-*,extension,limits-stored,set-timeout,reassign-moved-extension,reassign-targets,reassignment*,reminders,working-time}.test.ts",
      "tests/app/{tree-end-pauses,tree-end-pauses-units,list-pauses,pause-answer-log}.test.ts",
      "tests/metrics/pause-metrics.test.ts",
    ],
  },
});
