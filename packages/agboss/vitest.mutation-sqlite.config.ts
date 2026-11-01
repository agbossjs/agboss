import { defineConfig } from "vitest/config";

/**
 * The tests Stryker runs on the SQLite fencing stores (#626, shard `sqlite-stores` of
 * `stryker.config.mjs`): the store conformance on two connections to one file — every contract
 * and the interleavings —, the stores' own edges, and the fence, the fenced effect and the outbound
 * call run on them. One process, no nested vitest and no pods.
 */
export default defineConfig({
  test: {
    expect: { requireAssertions: true },
    setupFiles: ["./src/testing/setup.ts"],
    include: [
      "tests/infrastructure/{store-conformance.sqlite,live-lease-sqlite,repeated-execution-id.sqlite,in-memory-fenced-effect-edges,execution-lease-*-bites}.test.ts",
      "tests/infrastructure/sqlite/{sqlite-fenced-effect,sqlite-finished-leases,sqlite-instances,sqlite-tenants,sqlite-persistence,sqlite-remote-children,subclass}.test.ts",
      "tests/app/{execution-fence-stores,fenced-effect-sqlite,outbound-call-sqlite,held-lease-fence,held-lease-edges,lease-skew,lease-skew-charge}.test.ts",
    ],
  },
});
