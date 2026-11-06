import { defineConfig } from "vitest/config";

/**
 * The tests Stryker runs on the A2A client (#809, shard `a2a-client` of `stryker.config.mjs`): the
 * deterministic messageId, the accept's reconciliation by peer, which failures are definite, the
 * error translation (codes only), the origin policy and the fetch every request goes through, the
 * outcome of each task state and the mesh body hash. One process, no sockets.
 */
export default defineConfig({
  test: {
    expect: { requireAssertions: true },
    setupFiles: ["./src/testing/setup.ts"],
    include: [
      "tests/a2a/client/a2a-client-{units,accept.units,hardening,wire,in-execution}.test.ts",
      "tests/mesh/mesh-audience.test.ts",
      "tests/mcp/mcp-mesh-trust.test.ts",
      // #810: the mesh end to end, the takeover's charges
      "tests/a2a/mesh/*.test.ts",
    ],
  },
});
