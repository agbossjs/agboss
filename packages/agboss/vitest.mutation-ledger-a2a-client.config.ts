import { defineConfig } from "vitest/config";

/**
 * The tests Stryker runs on one call of the A2A client (#1366, shard `ledger-a2a-client` of `stryker.config.mjs`): what the peer's price charges at the accept and the wait, and the rest of the client (its options, card, cancel and file download). One process; the client's own tests reach a loopback peer.
 */
export default defineConfig({
  test: {
    // a hang of an async test is vitest's to end (the mutant is then Killed), never Stryker's Timeout (#1367)
    testTimeout: 20_000,
    hookTimeout: 20_000,
    expect: { requireAssertions: true },
    setupFiles: ["./src/testing/setup.ts"],
    include: [
      "tests/a2a/client/ledger-a2a-client-units.test.ts",
      "tests/a2a/a2a-price.test.ts",
      "tests/a2a/a2a-price-providers.test.ts",
      "tests/a2a/a2a-agent-rules.test.ts",
      "tests/a2a/client/ledger-a2a-client-reads.test.ts",
      "tests/a2a/client/ledger-a2a-client-card.test.ts",
      "tests/a2a/client/a2a-client-minimal-card.test.ts",
      // the rest of the client (a2a-client.ts is mutated whole): its options, its card, a cancel and a file's download
      "tests/a2a/client/a2a-client-{units,accept.units,hardening,wire,in-execution,files,direct,finishes-app}.test.ts",
    ],
  },
});
