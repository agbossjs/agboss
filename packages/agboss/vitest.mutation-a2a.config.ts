import { defineConfig } from "vitest/config";

/**
 * The tests Stryker runs on the A2A tasks (#807, shard `a2a-tasks` of `stryker.config.mjs`): the
 * task store's contract on the in-memory and SQLite stores, the reserved execution id, the cancel
 * of one tree and its durable state, the task projection and its read repair, and the server
 * (#808) over its binding. One process, no
 * nested vitest and no pods.
 */
export default defineConfig({
  test: {
    expect: { requireAssertions: true },
    setupFiles: ["./src/testing/setup.ts"],
    include: [
      "tests/infrastructure/a2a-task{.contract,-helpers}.test.ts",
      "tests/app/{execution-control,cancel-before-record,tree-control}.test.ts",
      "tests/a2a/a2a-task-{projection,units,retention}.test.ts",
      // #808: the server, over its JSON-RPC binding
      "tests/a2a/server/*.test.ts",
    ],
  },
});
