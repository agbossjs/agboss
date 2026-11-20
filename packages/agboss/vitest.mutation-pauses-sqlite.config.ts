import { defineConfig } from "vitest/config";

/**
 * The tests Stryker runs on the built-in SQLite pause store (#1356, shard `pauses-sqlite` of `stryker.config.mjs`): the pause store contract on SQLite, its names, kinds, answers and notices, the migration of the pauses table. One process, no
 * nested vitest and no pods.
 */
export default defineConfig({
  test: {
    expect: { requireAssertions: true },
    setupFiles: ["./src/testing/setup.ts"],
    // only the pause store contract of the conformance run, and every case of the other files
    testNamePattern: String.raw`paused execution contract|^(?!.*pass storeConformance)`,
    include: [
      "tests/infrastructure/store-conformance.sqlite.test.ts",
      "tests/infrastructure/{pause-store-units,pause-mailbox-store-units}.test.ts",
      "tests/infrastructure/sqlite/{pause-*,pauses-v2-migration,sqlite-pause-*,paused-run-unreadable}.test.ts",
      "tests/infrastructure/repeated-execution-id-pauses.sqlite.test.ts",
      "tests/app/{pause-reminders.sqlite,pause-expiry-instances.sqlite,pause-notice-crash.sqlite,cancel-paused-crash.sqlite}.test.ts",
    ],
  },
});
