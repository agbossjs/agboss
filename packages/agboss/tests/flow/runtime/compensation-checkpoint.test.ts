import { END, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import { CompensationEntryStatus, type CompensationEntry } from "../../../src/flow/compensation.js";
import { entriesInCheckpoint } from "../../../src/flow/runtime/compensation/checkpoint-entries.js";
import { bareRecordOf, ComponentKind } from "../../../src/flow/runtime/records.js";
import { ExecutionState, type ExecutionStateUpdate } from "../../../src/flow/runtime/state.js";

/**
 * #340 S3 Q-C — the one checkpoint reader: each execution of the tree (the root, a child under its
 * task's namespace) with its `compensations`, the unfinished superstep's pending writes applied —
 * what a task that finished before its sibling failed wrote is there, though the checkpoint's own
 * values do not have it yet (S2).
 */

const entry = (key: string, sequence: number): CompensationEntry => ({
  key,
  executionId: "root-1",
  sequence,
  action: "reserve-room-action",
  compensated: {
    component: bareRecordOf("reserve-room-action", ComponentKind.Action),
    nodeId: "reserve-room-action",
    visitNumber: 1,
    idempotencyKey: key,
    callId: undefined,
    itemIndex: undefined,
    copyNumber: 1,
    toolLoopIteration: undefined,
    validationAttempts: 0,
  },
  compensator: "release-room-action",
  input: {},
  status: CompensationEntryStatus.Open,
});

const update = (value: ExecutionStateUpdate) => (): ExecutionStateUpdate => value;

/** A child execution: its identity and one undoable action, then its own failure. */
const child = new StateGraph(ExecutionState)
  .addNode(
    "open",
    update({
      child: {
        executionId: "child-1",
        parentExecutionId: "root-1",
        rootExecutionId: "root-1",
        inheritedUsage: 0,
      },
      compensations: [{ ...entry("child-key", 1), executionId: "child-1" }],
    }),
  )
  .addNode("fail", () => {
    throw new Error("the child failed");
  })
  .addEdge(START, "open")
  .addEdge("open", "fail")
  .addEdge("fail", END)
  .compile();

/** The root: one undoable action, then a branch that finishes beside its failing sibling child. */
function rootGraph(saver: MemorySaver) {
  return (
    new StateGraph(ExecutionState)
      .addNode("open", update({ runId: "root-1", compensations: [entry("root-key", 1)] }))
      .addNode("branch", update({ compensations: [entry("branch-key", 2)] }))
      // run inside the parent's node: the child checkpoints under the task's namespace
      .addNode("child-workflow", async (_state, config): Promise<ExecutionStateUpdate> => {
        await child.invoke({ runId: "root-1" }, config);
        return {};
      })
      .addEdge(START, "open")
      .addEdge("open", "branch")
      .addEdge("open", "child-workflow")
      .addEdge("branch", END)
      .addEdge("child-workflow", END)
      .compile({ checkpointer: saver })
  );
}

describe("entriesInCheckpoint", () => {
  it("reads the root's entries with the pending writes, and the child's under its namespace", async () => {
    const saver = new MemorySaver();
    const config = { configurable: { thread_id: "thread-1" } };

    await expect(rootGraph(saver).invoke({}, config)).rejects.toThrow("the child failed");
    const found = await entriesInCheckpoint(saver, config, "root-1");

    const root = found.find((each) => each.namespace === "");
    expect(root?.entries.map((each) => each.key)).toEqual(["root-key", "branch-key"]);
    const children = found.filter((each) => each.namespace !== "");
    expect(children.map((each) => [each.executionId, each.entries.map((one) => one.key)])).toEqual([
      ["child-1", ["child-key"]],
    ]);
  });

  it("leaves out another tree's executions on the thread", async () => {
    const saver = new MemorySaver();
    const config = { configurable: { thread_id: "thread-1" } };
    await expect(rootGraph(saver).invoke({}, config)).rejects.toThrow("the child failed");

    expect(await entriesInCheckpoint(saver, config, "root-2")).toEqual([]);
  });
});
