// The shards of #1366: what is counted once in a child's execution, and in a call across the mesh (split from stryker-config for max-lines, re-exported by stryker-ranges.mjs).

/**
 * The `once-state` shard (#1366): the channels of the two states every pass of an execution reads and writes —
 * what each starts as and how an update joins what it holds (the spend appended, the counters added).
 */
export function onceStateShard() {
  return {
    configFile: "vitest.mutation-once-state.config.ts",
    mutate: ["src/flow/runtime/state.ts", "src/graph/agent-loop/state.ts"],
  };
}

/**
 * The `once-child` shard (#1366): a child's step in its parent, a child on any instance as its parent waits for it,
 * the queued child's pass on its worker (which spend it starts from) and the end its worker announces.
 */
export function onceChildShard() {
  return {
    configFile: "vitest.mutation-once-child.config.ts",
    mutate: [
      "src/flow/runtime/child.ts",
      "src/flow/runtime/remote/remote-child.ts",
      "src/app/remote/{child-end-event,queued-child-run}.ts",
    ],
  };
}

/** The `once-mesh` shard (#1366): an outbound call's envelope and a trusted MCP call that runs once. */
export function onceMeshShard() {
  return {
    configFile: "vitest.mutation-once-mesh.config.ts",
    mutate: ["src/mesh/outbound-mesh.ts", "src/mcp/mcp-dedupe.ts"],
  };
}
