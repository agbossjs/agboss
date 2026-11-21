import { defineConfig } from "vitest/config";

/**
 * The tests Stryker runs on a tree's end that closes its pauses and the pause step's answer (#1366, shard `cancel-x-pauses` of `stryker.config.mjs`).
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
      "tests/app/cancel-x-pauses-units.test.ts",
      "tests/app/tree-end-pauses-units.test.ts",
      "tests/app/pause-expiry-units.test.ts",
      "tests/app/cancel-x-pause-expiry-units.test.ts",
      "tests/channels/cancel-x-pause-step-units.test.ts",
      "tests/channels/cancel-x-pause-errors.test.ts",
      "tests/channels/pause-step{,-key,-deadline,-working-time}.test.ts",
    ],
  },
});
