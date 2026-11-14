/**
 * #1036: a checkpoint at any finite numeric step leaves its thread readable (`getTuple`, `list`,
 * `latestByStep`), and the newest by step is the one the scan names: an integer step of 2^53 or
 * more is not a read that throws.
 */
import { emptyCheckpoint, type CheckpointTuple } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import { newestFirstOrder, stepOf } from "../../../src/infrastructure/latest-by-step.js";
import { SqliteCheckpointSaver } from "../../../src/infrastructure/sqlite/sqlite-checkpoint-saver.js";
import { connectionTo, temporarySqlitePath } from "../contracts/store-kinds.js";

const at = { configurable: { thread_id: "t", checkpoint_ns: "" } };
const STEPS = [
  2 ** 53 - 1,
  2 ** 53,
  2 ** 53 + 2,
  2 ** 60,
  2 ** 63 - 1,
  1e19,
  1e20,
  2.5,
  -0.5,
  Number.MAX_VALUE,
];

describe("#1036 AC1: a huge or fractional step leaves the thread readable", () => {
  it.each(STEPS)(
    "AC1: step %s beside an ordinary one: all three reads succeed and agree with the scan",
    async (step) => {
      const saver = new SqliteCheckpointSaver(connectionTo(temporarySqlitePath()));
      await saver.put(
        at,
        { ...emptyCheckpoint(), id: "a" },
        { source: "loop", step: 1, parents: {} },
      );
      await saver.put(at, { ...emptyCheckpoint(), id: "b" }, { source: "loop", step, parents: {} });

      const listed: CheckpointTuple[] = [];
      for await (const tuple of saver.list(at)) listed.push(tuple);
      const scanned = listed
        .map((tuple) => ({ id: tuple.checkpoint.id, step: stepOf(tuple.metadata) }))
        .sort(newestFirstOrder)[0]?.id;

      expect(listed).toHaveLength(2);
      expect((await saver.getTuple(at))?.checkpoint.id).toBe("b");
      expect((await saver.latestByStep(at))?.checkpoint.id).toBe(scanned);
      expect((await saver.latestByStep(at))?.metadata?.step).toBe(Math.max(1, step));
    },
  );

  it("AC1: all of them in one thread: the newest by step is the greatest, as the scan says", async () => {
    const saver = new SqliteCheckpointSaver(connectionTo(temporarySqlitePath()));
    for (const [index, step] of STEPS.entries())
      await saver.put(
        at,
        { ...emptyCheckpoint(), id: `id-${String(index)}` },
        { source: "loop", step, parents: {} },
      );

    expect((await saver.latestByStep(at))?.metadata?.step).toBe(Number.MAX_VALUE);
    expect((await saver.getTuple(at))?.checkpoint.id).toBe(`id-${String(STEPS.length - 1)}`);
  });
});
