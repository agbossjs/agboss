import { defineConfig } from "vitest/config";

/**
 * The tests Stryker runs on the cancel fence of the in-memory and SQLite stores (#1356, shard `cancel-stores`
 * of `stryker.config.mjs`): the check, the mark and its seed row, the lease schema and its migration, the fenced
 * effects' retention. One process, no nested vitest and no pods.
 */
export default defineConfig({
  test: {
    expect: { requireAssertions: true },
    setupFiles: ["./src/testing/setup.ts"],
    include: [
      "tests/infrastructure/cancel-stores-units.test.ts",
      "tests/infrastructure/sqlite/sqlite-cancel-mark-migration.test.ts",
      "tests/infrastructure/sqlite/sqlite-cancel-child.test.ts",
    ],
  },
});
