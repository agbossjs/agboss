import { defineConfig } from "vitest/config";

/**
 * The tests Stryker runs on what a call across the mesh carries and on a trusted MCP call that runs once
 * (#1366, shard `once-mesh` of `stryker.config.mjs`): the envelope of an outbound call, its claims, its
 * signature and trace, `dedupedMcpCall` by (tenant, peer, call id) and the once-only claim of the
 * in-memory and SQLite mesh request stores under it (#1374). One process, no sockets.
 */
export default defineConfig({
  test: {
    expect: { requireAssertions: true },
    setupFiles: ["./src/testing/setup.ts"],
    include: [
      "tests/mesh/outbound-mesh.units.test.ts",
      "tests/mcp/mcp-dedupe.units.test.ts",
      // the claim of the stores themselves, in memory and in SQLite
      "tests/infrastructure/mesh-request-units.test.ts",
      // the dedupe end to end, over a real MCP session
      "tests/mcp/mcp-mesh-trust.test.ts",
    ],
  },
});
