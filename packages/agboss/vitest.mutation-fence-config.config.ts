import { defineConfig } from "vitest/config";

/**
 * The tests Stryker runs on the pairing of the fencing stores and the retentions above the lease (#1366, shard `fence-config` of `stryker.config.mjs`).
 * One process, no nested vitest and no pods.
 */
export default defineConfig({
  test: {
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
