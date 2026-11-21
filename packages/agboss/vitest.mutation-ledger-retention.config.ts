import { defineConfig } from "vitest/config";

/**
 * The tests Stryker runs on what the retention sweep removes and a knowledge base's spend (#1366, shard `ledger-retention` of `stryker.config.mjs`). One process, no pods.
 */
export default defineConfig({
  test: {
    // a hang of an async test is vitest's to end (the mutant is then Killed), never Stryker's Timeout (#1367)
    testTimeout: 20_000,
    hookTimeout: 20_000,
    expect: { requireAssertions: true },
    setupFiles: ["./src/testing/setup.ts"],
    include: [
      "tests/budgets/ledger-entry-retention.test.ts",
      "tests/infrastructure/recovery-log-repair.test.ts",
      "tests/rag/modes.test.ts",
      "tests/rag/rerank-pii.test.ts",
      "tests/rag/tenant-isolation.test.ts",
      "tests/infrastructure/ledger-retention-units.test.ts",
      "tests/rag/ledger-rag-spend.test.ts",
    ],
  },
});
