import type { RunnableConfig } from "@langchain/core/runnables";
import { emptyCheckpoint, type BaseCheckpointSaver } from "@langchain/langgraph";
import { expect } from "vitest";
import type { ContractCase } from "./define.js";
import type { ContractInstances } from "./instance-context.js";

/**
 * #1281b: a child's undoable actions move up to its parent through the checkpoints alone — the
 * child's finish writes them, moved (`heldBy`), in its own checkpoint beside the finish, and the
 * parent's step that ran it takes them (`childPath`) in its pending write. A saver keeps both as
 * written: nested ids and paths unchanged, on the other instance too, and the parent's write made
 * again by a takeover (the same task) kept once — so a retry neither loses nor doubles one.
 */

type Instances = ContractInstances<BaseCheckpointSaver>;

const PARENT = "parent-run";
const CHILD = "child-run";

const at = (threadId: string): RunnableConfig => ({
  configurable: { thread_id: threadId, checkpoint_ns: "" },
});

/** An undoable entry the child opened, as its finish moved it up to the parent. */
const moved = {
  key: `${CHILD}:reserve-seat-action:1`,
  executionId: CHILD,
  sequence: 1,
  action: "reserve-seat-action",
  compensated: { nodeId: "reserve-seat-action", visitNumber: 1, idempotencyKey: `${CHILD}:seat` },
  compensator: "release-seat-action",
  input: { "seat-dto": { valueId: "v-1", slot: "seat-dto", value: { seatId: "seat-1" } } },
  status: "open",
  heldBy: PARENT,
};

/** The same entry as the parent's step takes it: under its node of the child, in its branch. */
const taken = {
  ...moved,
  childPath: ["trip-child-workflow"],
  launchId: "launch-1",
  branchIndex: 0,
};

/** Puts one checkpoint of `threadId` at step 1 whose channels are `values`. */
const put = (
  saver: BaseCheckpointSaver,
  threadId: string,
  id: string,
  values: Readonly<Record<string, unknown>>,
): Promise<RunnableConfig> =>
  saver.put(
    at(threadId),
    {
      ...emptyCheckpoint(),
      id,
      channel_values: { ...values },
      channel_versions: Object.fromEntries(Object.keys(values).map((key) => [key, 1])),
    },
    { source: "loop", step: 1, parents: {} },
    Object.fromEntries(Object.keys(values).map((key) => [key, 1])),
  );

export const MOVED_ENTRIES_CASES: readonly ContractCase<BaseCheckpointSaver>[] = [
  {
    name: "a child's finish keeps the entries it moved up beside it, read whole on the other instance",
    run: async ({ first, second }: Instances): Promise<void> => {
      const values = { finish: "trip-child-workflow-finish", compensations: [moved] };
      await put(first, `${PARENT}/child/${CHILD}`, "checkpoint-1", values);

      const read = await second.getTuple(at(`${PARENT}/child/${CHILD}`));
      expect(read?.checkpoint.channel_values).toEqual(values);
      expect(await second.getTuple(at(PARENT))).toBeUndefined();
    },
  },
  {
    name: "the parent's step taking them, written again by a takeover, is kept once as first written",
    run: async ({ first, second }: Instances): Promise<void> => {
      const config = await put(first, PARENT, "checkpoint-1", { compensations: [] });

      await first.putWrites(config, [["compensations", [taken]]], "task-take");
      await second.putWrites(config, [["compensations", [{ ...taken, sequence: 9 }]]], "task-take");

      const read = await second.getTuple(config);
      expect(read?.pendingWrites).toEqual([["task-take", "compensations", [taken]]]);
    },
  },
];
