import { defineConfig } from "vitest/config";

/**
 * The tests Stryker runs on the pairing of the fencing stores and the retentions above the lease (#1366, shard `fence-config` of `stryker.config.mjs`).
 * One process, no nested vitest and no pods.
 */
export default defineConfig({
  test: {
    // a hang of an async test is vitest's to end (the mutant is then Killed), never Stryker's Timeout (#1367)
    testTimeout: 20_000,
    hookTimeout: 20_000,
    expect: { requireAssertions: true },
    setupFiles: ["./src/testing/setup.ts"],
    include: [
      "tests/application/fence-config-units.test.ts",
      "tests/application/retention.test.ts",
      "tests/application/store-backend-hints.test.ts",
      "tests/describe-application.test.ts",
    ],
  },
});
