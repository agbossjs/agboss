import type { RunnableConfig } from "@langchain/core/runnables";
import { emptyCheckpoint, type BaseCheckpointSaver } from "@langchain/langgraph";
import { expect } from "vitest";
import { pingCheckpointSaver } from "../../health/readiness-checks.js";
import { registerContract, type ContractCase } from "./define.js";
import type { ContractTarget } from "./seam.js";

/** The options `list` takes. */
type ListOptions = Parameters<BaseCheckpointSaver["list"]>[1];

const thread = (threadId: string): RunnableConfig => ({
  configurable: { thread_id: threadId, checkpoint_ns: "" },
});

/** A checkpoint with an id that sorts by time, and one channel value at version `step`. */
const checkpointOf = (id: string, step: number): ReturnType<typeof emptyCheckpoint> => ({
  ...emptyCheckpoint(),
  id,
  channel_values: { messages: [`step ${String(step)}`] },
  channel_versions: { messages: step },
});

/**
 * Two checkpoints of `threadId`, the second a child of the first; the second's config. Each `put`
 * passes the versions of the channels it changed, as LangGraph does (#511): a saver that writes a
 * channel's value only for the versions it is given (LangGraph's `PostgresSaver`) passes as it is.
 */
async function twoSteps(saver: BaseCheckpointSaver, threadId: string): Promise<RunnableConfig> {
  const first = await saver.put(
    thread(threadId),
    checkpointOf("checkpoint-1", 1),
    { source: "input", step: 1, parents: {} },
    { messages: 1 },
  );
  return saver.put(
    first,
    checkpointOf("checkpoint-2", 2),
    { source: "loop", step: 2, parents: {} },
    { messages: 2 },
  );
}

/** The ids of thread-1's checkpoints `saver` lists with `options`. */
async function listedIds(saver: BaseCheckpointSaver, options: ListOptions): Promise<string[]> {
  const found: string[] = [];
  for await (const tuple of saver.list(thread("thread-1"), options))
    found.push(tuple.checkpoint.id);
  return found;
}

const CHECKPOINT_CASES: readonly ContractCase<BaseCheckpointSaver>[] = [
  {
    name: "the latest checkpoint of a thread, saved on one instance, is read on the other with its parent",
    run: async ({ first, second }) => {
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
    },
  },
  {
    name: "pending writes: a regular write is kept as first written, a special one replaced",
    run: async ({ first, second }) => {
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
    },
  },
  {
    name: "list: newest first, with limit, before and a metadata filter",
    run: async ({ first, second }) => {
      await twoSteps(first, "thread-1");

      expect(await listedIds(second, {})).toEqual(["checkpoint-2", "checkpoint-1"]);
      expect(await listedIds(second, { limit: 1 })).toEqual(["checkpoint-2"]);
      const before = { configurable: { checkpoint_id: "checkpoint-2" } };
      expect(await listedIds(second, { before })).toEqual(["checkpoint-1"]);
      expect(await listedIds(second, { filter: { source: "input" } })).toEqual(["checkpoint-1"]);
    },
  },
  {
    name: "deleteThread removes the thread's checkpoints and writes, and only its own",
    run: async ({ first, second }) => {
      const config = await twoSteps(first, "thread-1");
      await twoSteps(first, "thread-2");
      await first.putWrites(config, [["messages", "pending"]], "task-1");

      await second.deleteThread("thread-1");

      expect(await first.getTuple(thread("thread-1"))).toBeUndefined();
      expect((await first.getTuple(thread("thread-2")))?.checkpoint.id).toBe("checkpoint-2");
    },
  },
];

/**
 * `BaseCheckpointSaver` (#265 AC7, S32) — LangGraph's contract, as the framework relies on it:
 * the latest checkpoint of a thread or one by id with its parent, pending writes (a regular write
 * kept as first written, a special one replaced), `list` newest first with `limit` / `before` /
 * `filter`, and `deleteThread`. Its ping is `ping()` when the saver has one, else a read of a
 * thread that does not exist — what readiness does.
 */
export function checkpointSaverContract(target: ContractTarget<BaseCheckpointSaver>): void {
  registerContract(
    "checkpoint saver contract",
    target,
    [{ cases: CHECKPOINT_CASES }],
    pingCheckpointSaver,
  );
}
