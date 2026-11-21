import { defineConfig } from "vitest/config";

/**
 * The tests Stryker runs on what the retention sweep removes and a knowledge base's spend (#1366, shard `ledger-retention` of `stryker.config.mjs`). One process, no pods.
 */
export default defineConfig({
  test: {
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
