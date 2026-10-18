/**
 * #265 AC7 (S32): `BaseCheckpointSaver` — LangGraph's contract, taken as is. `SqliteCheckpointSaver`
 * (our own, on `node:sqlite`) behaves as the in-memory default (`MemorySaver`): the latest
 * checkpoint of a thread or one by id with its parent, pending writes (a regular write kept as
 * first written, a special one replaced), `list` newest first with `limit` / `before` / `filter`,
 * and `deleteThread` — the SQLite one shared by two instances on one file.
 */
import type { RunnableConfig } from "@langchain/core/runnables";
import { BaseCheckpointSaver, emptyCheckpoint } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import { InMemoryCheckpointSaver } from "../../src/infrastructure/contracts.js";
import { SqliteCheckpointSaver } from "../../src/infrastructure/sqlite/sqlite-checkpoint-saver.js";
import { sharedInMemory, storeKinds } from "./contracts/store-kinds.js";

const kinds = storeKinds<BaseCheckpointSaver>({
  inMemory: (seam) => sharedInMemory(seam, "checkpoints", () => new InMemoryCheckpointSaver()),
  sqlite: ({ connection }) => new SqliteCheckpointSaver(connection()),
});

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

/** Two checkpoints of `threadId`, the second a child of the first; the second's config. */
async function twoSteps(saver: BaseCheckpointSaver, threadId: string): Promise<RunnableConfig> {
  const first = await saver.put(
    thread(threadId),
    checkpointOf("checkpoint-1", 1),
    {
      source: "input",
      step: 1,
      parents: {},
    },
    {},
  );
  return saver.put(
    first,
    checkpointOf("checkpoint-2", 2),
    {
      source: "loop",
      step: 2,
      parents: {},
    },
    {},
  );
}

describe.each(kinds)("#265 AC7: the checkpointer contract ($name)", ({ twoInstances }) => {
  it("the latest checkpoint of a thread, saved on one instance, is read on the other with its parent", async () => {
    const { first, second } = twoInstances();
    await twoSteps(first, "thread-1");

    const latest = await second.getTuple(thread("thread-1"));
    const byId = await second.getTuple({
      configurable: { thread_id: "thread-1", checkpoint_ns: "", checkpoint_id: "checkpoint-1" },
    });

    expect(latest?.checkpoint.channel_values).toEqual({ messages: ["step 2"] });
    expect(latest?.metadata).toMatchObject({ source: "loop", step: 2 });
    expect(latest?.parentConfig?.configurable?.checkpoint_id).toBe("checkpoint-1");
    expect(byId?.checkpoint.id).toBe("checkpoint-1");
    expect(byId?.parentConfig).toBeUndefined();
    expect(await second.getTuple(thread("thread-2"))).toBeUndefined();
  });

  it("pending writes: a regular write is kept as first written, a special one replaced", async () => {
    const { first, second } = twoInstances();
    const config = await twoSteps(first, "thread-1");

    await first.putWrites(config, [["messages", "first"]], "task-1");
    await second.putWrites(config, [["messages", "again"]], "task-1");
    await first.putWrites(config, [["__error__", "boom"]], "task-2");
    await second.putWrites(config, [["__error__", "boom again"]], "task-2");

    const tuple = await second.getTuple(config);
    expect(tuple?.pendingWrites).toEqual([
      ["task-1", "messages", "first"],
      ["task-2", "__error__", "boom again"],
    ]);
  });

  it("list: newest first, with limit, before and a metadata filter", async () => {
    const { first, second } = twoInstances();
    await twoSteps(first, "thread-1");

    const ids = async (options: Parameters<BaseCheckpointSaver["list"]>[1]): Promise<string[]> => {
      const found: string[] = [];
      for await (const tuple of second.list(thread("thread-1"), options)) {
        found.push(tuple.checkpoint.id);
      }
      return found;
    };

    expect(await ids({})).toEqual(["checkpoint-2", "checkpoint-1"]);
    expect(await ids({ limit: 1 })).toEqual(["checkpoint-2"]);
    expect(await ids({ before: { configurable: { checkpoint_id: "checkpoint-2" } } })).toEqual([
      "checkpoint-1",
    ]);
    expect(await ids({ filter: { source: "input" } })).toEqual(["checkpoint-1"]);
  });

  it("deleteThread removes the thread's checkpoints and writes, and only its own", async () => {
    const { first, second } = twoInstances();
    const config = await twoSteps(first, "thread-1");
    await twoSteps(first, "thread-2");
    await first.putWrites(config, [["messages", "pending"]], "task-1");

    await second.deleteThread("thread-1");

    expect(await first.getTuple(thread("thread-1"))).toBeUndefined();
    expect((await first.getTuple(thread("thread-2")))?.checkpoint.id).toBe("checkpoint-2");
  });
});

describe("#265 S32: SqliteCheckpointSaver's own checks", () => {
  const [, sqlite] = kinds;

  it("a config without a thread_id fails, naming the field", async () => {
    const saver = sqlite?.twoInstances().first;

    await expect(saver?.getTuple({ configurable: {} })).rejects.toThrow(/configurable\.thread_id/);
    await expect(
      saver?.putWrites({ configurable: { thread_id: "thread-1" } }, [["messages", 1]], "task-1"),
    ).rejects.toThrow(/checkpoint_id/);
  });

  it("list without a thread lists every thread's checkpoints", async () => {
    const saver = sqlite?.twoInstances().first;
    if (saver === undefined) throw new Error("no SQLite kind");
    await twoSteps(saver, "thread-1");
    await twoSteps(saver, "thread-2");

    const found: string[] = [];
    for await (const tuple of saver.list({})) {
      found.push(String(tuple.config.configurable?.thread_id));
    }

    expect(found).toHaveLength(4);
  });
});
