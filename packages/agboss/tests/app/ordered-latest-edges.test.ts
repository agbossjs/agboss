/**
 * #962 AC1 (edges): the checkpointer's latest read through `latestByStep` is the scan's answer:
 * a marked and an unmarked thread, a parent and a child namespace, a deleted thread, a read while
 * another instance writes.
 */
import type { RunnableConfig } from "@langchain/core/runnables";
import { BaseCheckpointSaver, emptyCheckpoint } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import { OrderedCheckpointSaver } from "../../src/app/leased-checkpointer.js";
import { InMemoryCheckpointSaver } from "../../src/infrastructure/contracts.js";
import { SqliteCheckpointSaver } from "../../src/infrastructure/sqlite/sqlite-checkpoint-saver.js";
import { connectionTo, temporarySqlitePath } from "../infrastructure/contracts/store-kinds.js";

const at = (thread: string, namespace = ""): RunnableConfig => ({
  configurable: { thread_id: thread, checkpoint_ns: namespace },
});

const put = (saver: BaseCheckpointSaver, where: RunnableConfig, id: string, step: number) =>
  saver.put(
    where,
    { ...emptyCheckpoint(), id, channel_values: { step }, channel_versions: { step } },
    { source: "loop", step, parents: {} },
    {},
  );

/** A saver that hides `latestByStep`: the scan. */
class Scanning extends BaseCheckpointSaver {
  constructor(private readonly inner: BaseCheckpointSaver) {
    super(inner.serde);
  }
  getTuple = (config: RunnableConfig) => this.inner.getTuple(config);
  list = (...args: Parameters<BaseCheckpointSaver["list"]>) => this.inner.list(...args);
  put = (...args: Parameters<BaseCheckpointSaver["put"]>) => this.inner.put(...args);
  putWrites = (...args: Parameters<BaseCheckpointSaver["putWrites"]>) =>
    this.inner.putWrites(...args);
  deleteThread = (threadId: string) => this.inner.deleteThread(threadId);
}

const stores: readonly (readonly [
  string,
  () => InMemoryCheckpointSaver | SqliteCheckpointSaver,
])[] = [
  ["in-memory", () => new InMemoryCheckpointSaver()],
  ["SQLite", () => new SqliteCheckpointSaver(connectionTo(temporarySqlitePath()))],
];

describe.each(stores)("#962 AC1: the checkpointer's latest read on %s", (_name, make) => {
  it("AC1: marked thread — a step back; the child namespace and another thread do not leak", async () => {
    const store = make();
    const fast = new OrderedCheckpointSaver(store);
    const scan = new OrderedCheckpointSaver(new Scanning(store));
    await put(fast, at("t"), "b-1", 0);
    await put(fast, at("t"), "b-2", 1);
    await put(fast, at("t"), "a-3", 2); // sorts before b-2: the thread is marked
    await put(fast, at("t", "child"), "z-9", 0);
    await put(fast, at("u"), "c-1", 5);

    for (const where of [at("t"), at("t", "child"), at("u"), at("nobody")])
      expect((await fast.getTuple(where))?.checkpoint.id).toBe(
        (await scan.getTuple(where))?.checkpoint.id,
      );
    expect((await fast.getTuple(at("t")))?.checkpoint.id).toBe("a-3");
    expect((await fast.getTuple(at("t", "child")))?.checkpoint.id).toBe("z-9");
  });

  it("AC1: unmarked thread is the saver's greatest id; a deleted thread has none, and starts unmarked", async () => {
    const fast = new OrderedCheckpointSaver(make());
    await put(fast, at("t"), "a-1", 0);
    await put(fast, at("t"), "a-2", 1);
    expect((await fast.getTuple(at("t")))?.checkpoint.id).toBe("a-2");
    await put(fast, at("t"), "a-0", 2);
    expect((await fast.getTuple(at("t")))?.checkpoint.id).toBe("a-0");

    await fast.deleteThread("t");

    expect(await fast.getTuple(at("t"))).toBeUndefined();
    await put(fast, at("t"), "m-1", 0);
    await put(fast, at("t"), "n-2", 1);
    expect((await fast.getTuple(at("t")))?.checkpoint.id).toBe("n-2");
  });

  it("AC1: a read while another instance writes is a whole checkpoint, never going back", async () => {
    const store = make();
    const writer = new OrderedCheckpointSaver(store);
    const reader = new OrderedCheckpointSaver(store);
    await put(writer, at("t"), "m-0", 0);
    await put(writer, at("t"), "a-1", 1); // marks
    let written = 1;
    const writes = (async () => {
      for (let step = 2; step < 40; step += 1) {
        await put(writer, at("t"), `a-${String(step).padStart(3, "0")}`, step);
        written = step;
      }
    })();
    let seen = 1;
    while (written < 39) {
      const tuple = await reader.getTuple(at("t"));
      const step = tuple?.metadata?.step ?? -1;
      expect(tuple?.checkpoint.channel_values).toEqual({ step });
      expect(step).toBeGreaterThanOrEqual(seen);
      seen = step;
    }
    await writes;
    expect((await reader.getTuple(at("t")))?.metadata?.step).toBe(39);
  });
});
