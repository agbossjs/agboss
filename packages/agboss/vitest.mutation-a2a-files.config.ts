import { defineConfig } from "vitest/config";

/**
 * The tests Stryker runs on the A2A file fetch (#1244, shard `a2a-files` of `stryker.config.mjs`):
 * the deny list, the resolve-vet-connect path, the peer check, redirects, the hand-written HTTP/1.1
 * response parser and its exchange, the fetch's bounds, and the file options, media check, scrub
 * and service around them. One process, no nested vitest and no pods.
 */
export default defineConfig({
  test: {
    // a hang of an async test is vitest's to end (the mutant is then Killed), never Stryker's Timeout (#1367)
    testTimeout: 20_000,
    hookTimeout: 20_000,
    expect: { requireAssertions: true },
    setupFiles: ["./src/testing/setup.ts"],
    include: [
      "tests/a2a/files/*.test.ts",
      "tests/a2a/files/mutation/*.test.ts",
      "tests/files/*.test.ts",
      // #1356: the download bounds
      "tests/a2a/client/a2a-download-policy-1316.test.ts",
    ],
  },
});
