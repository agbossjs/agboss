import { defineConfig } from "vitest/config";

/**
 * The tests Stryker runs on what a call across the mesh is charged (#1356, shard `mesh-charge` of
 * `stryker.config.mjs`): a verified report's charge, a call's price and the ledger identities of both. One
 * process, no nested vitest and no pods.
 */
export default defineConfig({
  test: {
    // a hang of an async test is vitest's to end (the mutant is then Killed), never Stryker's Timeout (#1367)
    testTimeout: 20_000,
    hookTimeout: 20_000,
    expect: { requireAssertions: true },
    setupFiles: ["./src/testing/setup.ts"],
    include: [
      "tests/mesh/mesh-charge-units.test.ts",
      "tests/mesh/report-made-at.test.ts",
      "tests/mesh/mesh-report-verify.test.ts",
      "tests/a2a/client/a2a-report-record.units.test.ts",
      // the mesh a call rides (a2a-mesh-seam.ts): its envelope, the loop and the required-mesh refusals, end to end
      "tests/a2a/client/a2a-client-mesh.units.test.ts",
      "tests/a2a/client/mesh-charge-seam.test.ts",
      "tests/a2a/mesh/*.test.ts",
      // #1356: the MCP call's identity
      "tests/mcp/mcp-client-call.test.ts",
      "tests/mcp/mcp-call-frame-ids.test.ts",
      "tests/mcp/mcp-call-identity-exact.test.ts",
      // #1318: the tokens a remote run reports and a caller counts
      "tests/mesh/mesh-report-tokens.test.ts",
    ],
  },
});
