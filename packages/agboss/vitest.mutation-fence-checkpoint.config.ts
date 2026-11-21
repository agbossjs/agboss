import { defineConfig } from "vitest/config";

/**
 * The tests Stryker runs on the leased and the ordered checkpoint savers and the observed pass (#1366, shard `fence-checkpoint` of `stryker.config.mjs`).
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
      "tests/app/fence-checkpoint-units.test.ts",
      "tests/app/fence-observed-pass-units.test.ts",
      "tests/app/{ordered-checkpoint-saver,ordered-code-point,ordered-latest-edges,lease-scope-checkpoint}.test.ts",
    ],
  },
});
