/**
 * #265 AC7 (S32): `SqliteCheckpointSaver`'s own checks. The published checkpoint saver contract runs
 * on the core's savers in store-conformance.in-memory.test.ts and store-conformance.sqlite.test.ts
 * (#526, `storeConformance`).
 */
import type { RunnableConfig } from "@langchain/core/runnables";
import { BaseCheckpointSaver, emptyCheckpoint } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import { SqliteCheckpointSaver } from "../../src/infrastructure/sqlite/sqlite-checkpoint-saver.js";
import { withTarget } from "../../src/testing/contracts/seam.js";
import { sqliteTarget } from "./contracts/store-kinds.js";

const sqlite = sqliteTarget<BaseCheckpointSaver>(
  ({ connection }) => new SqliteCheckpointSaver(connection()),
);

const thread = (threadId: string): RunnableConfig => ({
  configurable: { thread_id: threadId, checkpoint_ns: "" },
});

/** A checkpoint with an id that sorts by time, and one channel value. */
const checkpointOf = (id: string, step: number): ReturnType<typeof emptyCheckpoint> => ({
  ...emptyCheckpoint(),
  id,
  channel_values: { messages: [`step ${String(step)}`] },
  channel_versions: { messages: step },
});

/** Two checkpoints of `threadId`, the second a child of the first. */
async function twoSteps(saver: BaseCheckpointSaver, threadId: string): Promise<void> {
  const first = await saver.put(
    thread(threadId),
    checkpointOf("checkpoint-1", 1),
    { source: "input", step: 1, parents: {} },
    {},
  );
  await saver.put(
    first,
    checkpointOf("checkpoint-2", 2),
    { source: "loop", step: 2, parents: {} },
    {},
  );
}

describe("#265 S32: SqliteCheckpointSaver's own checks", () => {
  it(
    "a config without a thread_id fails, naming the field",
    withTarget(sqlite, async ({ first: saver }) => {
      await expect(saver.getTuple({ configurable: {} })).rejects.toThrow(/configurable\.thread_id/);
      await expect(
        saver.putWrites({ configurable: { thread_id: "thread-1" } }, [["messages", 1]], "task-1"),
      ).rejects.toThrow(/checkpoint_id/);
    }),
  );

  it(
    "list without a thread lists every thread's checkpoints",
    withTarget(sqlite, async ({ first: saver }) => {
      await twoSteps(saver, "thread-1");
      await twoSteps(saver, "thread-2");

      const found: string[] = [];
      for await (const tuple of saver.list({})) {
        found.push(String(tuple.config.configurable?.thread_id));
      }

      expect(found).toHaveLength(4);
    }),
  );
});
