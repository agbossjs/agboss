import { defineConfig } from "vitest/config";

/**
 * The tests Stryker runs on one call of the A2A client (#1366, shard `ledger-a2a-client` of `stryker.config.mjs`): what the peer's price charges at the accept and the wait. One process, no sockets.
 */
export default defineConfig({
  test: {
    // a hang of an async test is vitest's to end (the mutant is then Killed), never Stryker's Timeout (#1367)
    testTimeout: 20_000,
    hookTimeout: 20_000,
    expect: { requireAssertions: true },
    setupFiles: ["./src/testing/setup.ts"],
    include: ["tests/a2a/client/ledger-a2a-client-units.test.ts"],
  },
});
