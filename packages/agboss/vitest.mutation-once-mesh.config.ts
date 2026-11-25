import { defineConfig } from "vitest/config";

/**
 * The tests Stryker runs on what a call across the mesh carries and on a trusted MCP call that runs once
 * (#1366, shard `once-mesh` of `stryker.config.mjs`): the envelope of an outbound call, its claims, its
 * signature and trace, `dedupedMcpCall` by (tenant, peer, call id), the signed report of a trusted call (`runReportMetaOf`: the issuer, the execution, the spend a caller charges from) and the once-only claim of the
 * in-memory and SQLite mesh request stores under it (#1374). One process, no sockets.
 */
export default defineConfig({
  test: {
    // a hang of an async test is vitest's to end (the mutant is then Killed), never Stryker's Timeout (#1367)
    testTimeout: 20_000,
    hookTimeout: 20_000,
    expect: { requireAssertions: true },
    setupFiles: ["./src/testing/setup.ts"],
    include: [
      "tests/mesh/outbound-mesh.units.test.ts",
      "tests/mcp/mcp-dedupe.units.test.ts",
      // the claim of the stores themselves, in memory and in SQLite
      "tests/infrastructure/mesh-request-units.test.ts",
      // the signed report a trusted call returns: its facts, one by one
      "tests/mcp/mcp-run-report.units.test.ts",
      // the dedupe end to end, over a real MCP session
      "tests/mcp/mcp-mesh-trust.test.ts",
      // the identity and ledger key of a call, keyless included: its position, its arguments, its explicit key
      "tests/mcp/{mcp-client-call,mcp-call-frame-ids}.test.ts",
    ],
  },
});
