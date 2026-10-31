import { defineConfig } from "vitest/config";

/**
 * The tests Stryker runs on the fencing modules (#533 item 3): the fence, the held lease, the
 * leases, the fenced effect and the outbound call's protocol and stores — in memory, one process,
 * no nested vitest and no pods, so a mutant's run stays short. `stryker.config.mjs` names the
 * modules it mutates; `npm run test:mutation` runs it.
 */
export default defineConfig({
  test: {
    expect: { requireAssertions: true },
    setupFiles: ["./src/testing/setup.ts"],
    include: [
      "tests/app/{execution-fence*,fenced-effect*,finished-work-takeover,held-lease*,lease-*,outbound-call*,outbound-calls-read}.test.ts",
      "tests/infrastructure/{in-memory-fenced-effect*,lease-fencing,lease-supersede,execution-lease-*-bites,store-conformance.in-memory,fenced-key-helpers,outbound-call-naive-store,system-clock,live-lease-sqlite,in-memory-store-edges}.test.ts",
      "tests/properties/*.property.test.ts",
    ],
  },
});
