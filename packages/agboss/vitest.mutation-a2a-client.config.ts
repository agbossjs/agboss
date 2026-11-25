import { defineConfig } from "vitest/config";

/**
 * The tests Stryker runs on the A2A client (#809, shard `a2a-client` of `stryker.config.mjs`): the
 * deterministic messageId, the accept's reconciliation by peer, which failures are definite, the
 * error translation (codes only), the origin policy and the fetch every request goes through, the
 * outcome of each task state (#916: a finish the client does not take) and the mesh body hash. One
 * process, no sockets.
 */
export default defineConfig({
  test: {
    // a hang of an async test is vitest's to end (the mutant is then Killed), never Stryker's Timeout (#1367)
    testTimeout: 20_000,
    hookTimeout: 20_000,
    expect: { requireAssertions: true },
    setupFiles: ["./src/testing/setup.ts"],
    include: [
      // #1166: a stored text that is no JSON is the coded unreadable refusal, at every site
      "tests/infrastructure/sqlite/stored-not-json-sites.test.ts",
      "tests/a2a/client/a2a-client-{units,accept.units,mesh.units,hardening,wire,in-execution,files,direct,finishes-app}.test.ts",
      "tests/mesh/mesh-audience.test.ts",
      "tests/mesh/mesh-verification-units.test.ts",
      // #1320: what a client signs, and never across an origin
      "tests/a2a/client/a2a-mesh-http-sign.test.ts",
      "tests/mcp/mcp-signed-fetch.test.ts",
      "tests/mcp/mcp-mesh-trust.test.ts",
      // #810: the mesh end to end, the takeover's charges
      "tests/a2a/mesh/*.test.ts",
    ],
  },
});
