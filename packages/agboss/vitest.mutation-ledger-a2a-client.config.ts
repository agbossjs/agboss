import { defineConfig } from "vitest/config";

/**
 * The tests Stryker runs on one call of the A2A client (#1366, shard `ledger-a2a-client` of `stryker.config.mjs`): what the peer's price charges at the accept and the wait. One process, no sockets.
 */
export default defineConfig({
  test: {
    expect: { requireAssertions: true },
    setupFiles: ["./src/testing/setup.ts"],
    include: ["tests/a2a/client/ledger-a2a-client-units.test.ts"],
  },
});
