import { defineConfig } from "vitest/config";

/**
 * The tests Stryker runs on the fenced reach (#1356, shard `fenced-reach` of `stryker.config.mjs`): the
 * fence view a step reads, the fenced effects a component injects, and the components that reach a writer
 * under business keys. One process, no nested vitest and no pods.
 */
export default defineConfig({
  test: {
    // a hang of an async test is vitest's to end (the mutant is then Killed), never Stryker's Timeout (#1367)
    testTimeout: 20_000,
    hookTimeout: 20_000,
    expect: { requireAssertions: true },
    setupFiles: ["./src/testing/setup.ts"],
    include: [
      "tests/flow/context/execution-fence-view.test.ts",
      "tests/app/{fenced-effects,execution-fence}.test.ts",
      "tests/components/fenced-reach.test.ts",
      // the effect a direct-reply A2A skill's nodes reach (src/a2a/a2a-effect-reach.ts)
      "tests/a2a/direct/direct-rule-units.test.ts",
      "tests/a2a/direct/direct-rules.test.ts",
    ],
  },
});
