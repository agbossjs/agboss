import { defineConfig } from "vitest/config";

/**
 * The tests Stryker runs on the fenced reach (#1356, shard `fenced-reach` of `stryker.config.mjs`): the
 * fence view a step reads, the fenced effects a component injects, and the components that reach a writer
 * under business keys. One process, no nested vitest and no pods.
 */
export default defineConfig({
  test: {
    expect: { requireAssertions: true },
    setupFiles: ["./src/testing/setup.ts"],
    include: [
      "tests/flow/context/execution-fence-view.test.ts",
      "tests/app/{fenced-effects,execution-fence}.test.ts",
      "tests/components/fenced-reach.test.ts",
    ],
  },
});
