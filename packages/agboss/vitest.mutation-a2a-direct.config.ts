import { defineConfig } from "vitest/config";

/**
 * The tests Stryker runs on the direct A2A replies (#860, shard `a2a-direct` of
 * `stryker.config.mjs`): the server's direct-reply path over its JSON-RPC binding and the official
 * SDK client, the store contract in memory and on SQLite, the sweep, the assembly rules, the run no
 * recovery continues, the client of a direct skill, the TCK's scenario; #900's decision scan. One
 * process, no nested vitest and no pods.
 */
export default defineConfig({
  test: {
    expect: { requireAssertions: true },
    setupFiles: ["./src/testing/setup.ts"],
    include: [
      "tests/a2a/direct/*.test.ts",
      "tests/infrastructure/a2a-direct-message.contract.test.ts",
      "tests/app/without-recovery.test.ts",
      "tests/a2a/client/a2a-client-direct.test.ts",
      "tests/a2a/files/a2a-forged-decision.test.ts",
      "tests/a2a-tck/tck-sut.test.ts",
    ],
  },
});
