import { defineConfig } from "vitest/config";

/**
 * The tests Stryker runs on the A2A file fetch (#1244, shard `a2a-files` of `stryker.config.mjs`):
 * the deny list, the resolve-vet-connect path, the peer check, redirects, the hand-written HTTP/1.1
 * response parser and its exchange, the fetch's bounds, and the file options, media check, scrub
 * and service around them. One process, no nested vitest and no pods.
 */
export default defineConfig({
  test: {
    expect: { requireAssertions: true },
    setupFiles: ["./src/testing/setup.ts"],
    include: [
      "tests/a2a/files/*.test.ts",
      "tests/a2a/files/mutation/*.test.ts",
      "tests/files/*.test.ts",
    ],
  },
});
