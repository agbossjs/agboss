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
    // a hang of an async test is vitest's to end (the mutant is then Killed), never Stryker's Timeout (#1367)
    testTimeout: 20_000,
    hookTimeout: 20_000,
    expect: { requireAssertions: true },
    setupFiles: ["./src/testing/setup.ts"],
    include: [
      // #1166: a stored text that is no JSON is the coded unreadable refusal, at every site
      "tests/infrastructure/sqlite/stored-not-json-sites.test.ts",
      "tests/infrastructure/a2a-task{.contract,-helpers,-pages-units,-status-rows,-mutation-rows}.test.ts",
      "tests/app/{execution-control,cancel-before-record,tree-control,execution-trees-mutation}.test.ts",
      "tests/a2a/a2a-task-{projection,units,retention}.test.ts",
      // #844: a repaired task's spend, its memory update included
      // #808: the server, over its JSON-RPC binding
      "tests/a2a/server/*.test.ts",
      // #810: the mesh end to end
      "tests/a2a/mesh/*.test.ts",
      // #860: a run no recovery continues, a direct reply's task-less path
      "tests/app/without-recovery.test.ts",
      "tests/a2a/direct/*.test.ts",
      // #1325a: a recorded third-party error with a leaking code is still `internal` in a task's status
      "tests/errors/recorded-error-boundaries.test.ts",
      // #1356: the A2A task sweep's race
      "tests/infrastructure/sqlite/sqlite-a2a-task-sweep-race.test.ts",
    ],
  },
});
