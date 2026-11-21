import { defineConfig } from "vitest/config";

/**
 * The tests Stryker runs on the orphan look's end of a tree, the pause deadline's move and a child's announced failure (#1366, shard `fence-tree` of `stryker.config.mjs`).
 * One process, no nested vitest and no pods.
 */
export default defineConfig({
  test: {
    expect: { requireAssertions: true },
    setupFiles: ["./src/testing/setup.ts"],
    include: [
      "tests/app/fence-tree-units.test.ts",
      "tests/app/fence-tree-expiry-units.test.ts",
      "tests/app/tree-moves-units.test.ts",
      "tests/app/pause-expiry-units.test.ts",
    ],
  },
});
