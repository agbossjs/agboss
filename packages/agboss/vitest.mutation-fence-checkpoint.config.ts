import { defineConfig } from "vitest/config";

/**
 * The tests Stryker runs on the leased and the ordered checkpoint savers and the observed pass (#1366, shard `fence-checkpoint` of `stryker.config.mjs`).
 * One process, no nested vitest and no pods.
 */
export default defineConfig({
  test: {
    expect: { requireAssertions: true },
    setupFiles: ["./src/testing/setup.ts"],
    include: [
      "tests/app/fence-checkpoint-units.test.ts",
      "tests/app/fence-observed-pass-units.test.ts",
      "tests/app/{ordered-checkpoint-saver,ordered-code-point,ordered-latest-edges,lease-scope-checkpoint}.test.ts",
    ],
  },
});
