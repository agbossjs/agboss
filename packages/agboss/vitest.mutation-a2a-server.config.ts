import { defineConfig } from "vitest/config";

/**
 * The tests Stryker runs on the A2A server (#824, shard `a2a-server` of `stryker.config.mjs`): the
 * server over its JSON-RPC binding and the official SDK client — accept, follow-ups, cancel, the
 * waits and streams, ListTasks — and the assembly rule on where an application keeps its A2A
 * tasks. One process, no nested vitest and no pods.
 */
export default defineConfig({
  test: {
    expect: { requireAssertions: true },
    setupFiles: ["./src/testing/setup.ts", "./tests/helpers/chat-client-setup.ts"],
    include: [
      "tests/a2a/server/*.test.ts",
      "tests/a2a/a2a-task-store-rule*.test.ts",
      // #810: the mesh end to end
      "tests/a2a/mesh/*.test.ts",
      // #859: file parts in messages and artifacts
      "tests/a2a/files/*.test.ts",
      // #860: the direct replies' server path and the store rules
      "tests/a2a/direct/*.test.ts",
    ],
  },
});
