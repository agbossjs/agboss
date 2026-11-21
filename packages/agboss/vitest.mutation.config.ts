import { defineConfig } from "vitest/config";

/**
 * The tests Stryker runs on the fencing modules (#533 item 3): the fence, the held lease, the
 * leases, the fenced effect and the outbound call's protocol and stores — in memory, one process,
 * no nested vitest and no pods, so a mutant's run stays short. `stryker.config.mjs` names the
 * modules it mutates, in two shards over these tests (`fencing` and `fencing-effects`, #1242);
 * `npm run test:mutation` runs it.
 */
export default defineConfig({
  test: {
    // a hang of an async test is vitest's to end (the mutant is then Killed), never Stryker's Timeout (#1367)
    testTimeout: 20_000,
    hookTimeout: 20_000,
    expect: { requireAssertions: true },
    setupFiles: ["./src/testing/setup.ts"],
    // #1242: the in-memory explorer one step less deep than the regular suite's 10 (see the test)
    env: { AGBOSS_MUTATION_EXPLORER_DEPTH: "9" },
    include: [
      "tests/app/{execution-fence*,fenced-effect*,finished-work-takeover,held-lease*,lease-*,outbound-call*,outbound-calls-read,pending-calls-paging,fingerprint-required}.test.ts",
      "tests/infrastructure/{in-memory-fenced-effect*,lease-fencing,lease-supersede,execution-lease-*-bites,store-conformance.in-memory,fenced-key-helpers,outbound-call-naive-store,system-clock,lazy-loads,live-lease-sqlite,in-memory-store-edges,fenced-effect-join-fingerprint,minted-id-key-text,repeated-execution-id,execution-ids,execution-id-store-token,fence-fingerprint,outbound-call-pages}.test.ts",
      "tests/application/{store-descriptor,key-fields}.test.ts",
      "tests/properties/*.property.test.ts",
      "tests/turns/minted-thread-exhausted.test.ts",
      "tests/core/defined-of.test.ts",
    ],
  },
});
