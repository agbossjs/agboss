import { defineConfig } from "vitest/config";

/**
 * The tests Stryker runs on what a call across the mesh is charged (#1356, shard `mesh-charge` of
 * `stryker.config.mjs`): a verified report's charge, a call's price and the ledger identities of both. One
 * process, no nested vitest and no pods.
 */
export default defineConfig({
  test: {
    expect: { requireAssertions: true },
    setupFiles: ["./src/testing/setup.ts"],
    include: [
      "tests/mesh/mesh-charge-units.test.ts",
      "tests/mesh/report-made-at.test.ts",
      "tests/a2a/client/a2a-report-record.units.test.ts",
    ],
  },
});
