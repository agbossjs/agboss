import { defineConfig } from "vitest/config";

/**
 * The tests Stryker runs on undo (#633, shards `undo` and `unwind` of `stryker.config.mjs`): the
 * compensation runtime's entries, marks and unwinds, a failed join's undo, the undo matrices, an
 * undo a takeover or a cancel finishes, an undo the budget holds. One process, no nested vitest and
 * no pods.
 */
export default defineConfig({
  test: {
    // a hang of an async test is vitest's to end (the mutant is then Killed), never Stryker's Timeout (#1367)
    testTimeout: 20_000,
    hookTimeout: 20_000,
    expect: { requireAssertions: true },
    setupFiles: ["./src/testing/setup.ts"],
    include: [
      "tests/flow/runtime/{compensation-*,on-error,child-failure,launch-failure,in-parallel,for-each-item,action-errors,*-units}.test.ts",
      "tests/app/compensation/*-units.test.ts",
      "tests/app/unwinding-takeover-units.test.ts",
      "tests/app/{compensation-*,kept-undo-*,undo-*,action-fence,child-failure-once,*end-once*,finished-work*,error-class-route,zombie-evidence,cancel*,execution-fence}.test.ts",
      "tests/budgets/{held-undo,held-branch,exemption-scope}.test.ts",
      "tests/infrastructure/{sqlite/sqlite-unwind,execution-lease-retire-bites}.test.ts",
      "tests/errors/recorded-error.test.ts",
    ],
  },
});
