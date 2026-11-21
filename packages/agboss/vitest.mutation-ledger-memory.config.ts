import { defineConfig } from "vitest/config";

/**
 * The tests Stryker runs on the spend of a thread's memory (#1366, shard `ledger-memory` of `stryker.config.mjs`): the strategies' update after a turn and the compactions before an execution. One process, no pods.
 */
export default defineConfig({
  test: {
    expect: { requireAssertions: true },
    setupFiles: ["./src/testing/setup.ts"],
    include: [
      "tests/compaction/compaction.test.ts",
      "tests/compaction/custom-compaction.test.ts",
      "tests/memory/memory-strategies.test.ts",
      "tests/memory/sliding-window.test.ts",
      "tests/run/ledger-memory-units.test.ts",
      "tests/run/ledger-compaction.test.ts",
      "tests/run/ledger-compaction-parts.test.ts",
    ],
  },
});
