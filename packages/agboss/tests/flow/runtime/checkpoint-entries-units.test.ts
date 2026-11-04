/**
 * #633 (undo shard) — the one reader of undoable actions from a checkpoint (`entriesInCheckpoint`)
 * on a saver of its own: each namespace's newest checkpoint only, an execution's own entries, the
 * unfinished superstep's writes to the channel applied, a child's thread read under its task's
 * namespace — and nothing the framework did not write taken for an entry.
 */
import { describe, expect, it } from "vitest";
import type { BaseCheckpointSaver, CheckpointTuple } from "@langchain/langgraph";
import { CompensationEntryStatus } from "../../../src/flow/compensation.js";
import { entriesInCheckpoint } from "../../../src/flow/runtime/compensation/checkpoint-entries.js";
import { entryOf } from "./fixtures/compensation-entries.js";

const ROOT = "root-1";

interface TupleSpec {
  readonly namespace?: string | undefined;
  readonly values: Record<string, unknown>;
  readonly pending?: [string, string, unknown][];
  /** No `configurable` on the tuple's config at all. */
  readonly bare?: boolean;
}

const tupleOf = (spec: TupleSpec): CheckpointTuple =>
  ({
    config: spec.bare === true ? {} : { configurable: { checkpoint_ns: spec.namespace } },
    checkpoint: { channel_values: spec.values },
    ...(spec.pending === undefined ? {} : { pendingWrites: spec.pending }),
  }) as never;

/** A saver whose threads list the given tuples, newest first. */
const saverOf = (threads: Record<string, readonly TupleSpec[]>): BaseCheckpointSaver =>
  ({
    async *list(config: { configurable?: { thread_id?: string } }) {
      for (const spec of threads[config.configurable?.thread_id ?? ""] ?? []) yield tupleOf(spec);
    },
  }) as never;

const read = (threads: Record<string, readonly TupleSpec[]>) =>
  entriesInCheckpoint(saverOf(threads), { configurable: { thread_id: "thread-1" } }, ROOT);

const keysOf = (found: Awaited<ReturnType<typeof read>>) =>
  found.map((each) => [each.namespace, each.executionId, each.entries.map((entry) => entry.key)]);

describe("#633: the root's entries", () => {
  it("its namespace's newest checkpoint only; its own entries only", async () => {
    const found = await read({
      "thread-1": [
        {
          namespace: "",
          values: {
            runId: ROOT,
            compensations: [entryOf("mine"), entryOf("child's", { executionId: "child-1" })],
          },
        },
        { namespace: "", values: { runId: ROOT, compensations: [entryOf("older")] } },
      ],
    });

    expect(keysOf(found)).toEqual([["", ROOT, ["mine"]]]);
  });

  it("a tuple whose config names no namespace is the root's", async () => {
    const found = await read({
      "thread-1": [{ bare: true, values: { runId: ROOT, compensations: [entryOf("mine")] } }],
    });

    expect(keysOf(found)).toEqual([["", ROOT, ["mine"]]]);
  });

  it("another tree's root on the thread: not read", async () => {
    const found = await read({
      "thread-1": [{ namespace: "", values: { runId: "root-2", compensations: [entryOf("x")] } }],
    });

    expect(found).toEqual([]);
  });
});

describe("#633: the channel's boundary", () => {
  it.each([
    ["no list", { not: "a list" }],
    ["a list with a value that is no object", [entryOf("a"), 7]],
    ["an entry without a text key", [{ ...entryOf("a"), key: 1 }]],
    ["an entry without a numbered place", [{ ...entryOf("a"), sequence: "1" }]],
    ["an entry of no known status", [{ ...entryOf("a"), status: "lost" }]],
    ["one good entry and one bad", [entryOf("a"), { ...entryOf("b"), status: "lost" }]],
  ])("%s: no entries", async (_case, compensations) => {
    const found = await read({
      "thread-1": [{ namespace: "", values: { runId: ROOT, compensations } }],
    });

    expect(found.map((each) => each.entries)).toEqual([[]]);
  });

  it("the unfinished superstep's writes to the channel applied; other channels' and bad ones not", async () => {
    const closed = { ...entryOf("a"), status: CompensationEntryStatus.Closed };
    const found = await read({
      "thread-1": [
        {
          namespace: "",
          values: { runId: ROOT, compensations: [entryOf("a")] },
          pending: [
            ["task-1", "compensations", [closed]],
            ["task-2", "other", [entryOf("other")]],
            ["task-3", "compensations", [{ key: 1 }]],
          ],
        },
      ],
    });

    expect(found[0]?.entries).toEqual([closed]);
  });

  it("no channel and no writes: no entries", async () => {
    const found = await read({ "thread-1": [{ namespace: "", values: { runId: ROOT } }] });

    expect(found.map((each) => each.entries)).toEqual([[]]);
  });
});

describe("#633: children", () => {
  it("a child under its task: its own id, when it names one in text", async () => {
    const found = await read({
      "thread-1": [
        {
          namespace: "book:1",
          values: {
            child: { rootExecutionId: ROOT, executionId: "child-1" },
            compensations: [entryOf("c", { executionId: "child-1" })],
          },
        },
        {
          namespace: "odd:1",
          values: { child: { rootExecutionId: ROOT, executionId: 5 }, compensations: [] },
        },
      ],
    });

    expect(keysOf(found)).toEqual([["book:1", "child-1", ["c"]]]);
  });

  it("a child on its own thread: read under its task's namespace, its own below it", async () => {
    const found = await read({
      "thread-1": [{ namespace: "book:1", values: { childThread: "thread-1/child/child-1" } }],
      "thread-1/child/child-1": [
        {
          namespace: "",
          values: {
            child: { rootExecutionId: ROOT, executionId: "child-1" },
            compensations: [entryOf("c", { executionId: "child-1" })],
          },
        },
        {
          namespace: "nested:1",
          values: {
            child: { rootExecutionId: ROOT, executionId: "grandchild-1" },
            compensations: [entryOf("g", { executionId: "grandchild-1" })],
          },
        },
      ],
    });

    expect(keysOf(found)).toEqual([
      ["book:1", "child-1", ["c"]],
      ["book:1|nested:1", "grandchild-1", ["g"]],
    ]);
  });
});
