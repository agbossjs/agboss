import { defineConfig } from "vitest/config";

/**
 * The tests Stryker runs on the business-key identity and the outbound call's runtime (#626, shard
 * `keys-and-calls` of `stryker.config.mjs`): the key's text rules and fingerprints, the business
 * keys, the outbound calls' sends, joins, endings and reads, the store conformance in memory and the
 * properties. One process, no nested vitest and no pods.
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
      // #1166: a stored text that is no JSON is the coded unreadable refusal, at every site
      "tests/infrastructure/sqlite/stored-not-json-sites.test.ts",
      "tests/app/{business-key*,key-text*,*-key-text*,fenced-effect*,outbound-call*,outbound-calls-read,fingerprint-required,idempotency-key-rotation,pending-calls-paging}.test.ts",
      "tests/infrastructure/{key-text*,fenced-key-helpers,fenced-key-identity,fenced-key-errors,minted-id-key-text,fenced-effect-join-fingerprint,outbound-call-naive-store,store-conformance.in-memory,in-memory-store-edges}.test.ts",
      // #825: who reaches a writer of business keys, as the assembly rule names it
      "tests/application/key-fields.test.ts",
      // the framework's errors and the wording of the key text rules (src/core/errors.ts is mutated whole)
      "tests/core/errors-units.test.ts",
      "tests/properties/*.property.test.ts",
      // #1356: the call ids' other tests
      "tests/infrastructure/lease-fencing.test.ts",
      "tests/graph/budget-loop-model-calls.test.ts",
    ],
  },
});
