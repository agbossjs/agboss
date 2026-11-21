/**
 * #1366, #1165 (shard `fence-checkpoint`) on their own: a checkpoint is written only after the lease was renewed
 * (`LeasedCheckpointSaver`), and the thread's latest checkpoint is the one written last whatever order the ids
 * sort in (`OrderedCheckpointSaver`) — read with the fewest round trips the documented rule allows (one more look
 * for the mark per latest read, a floor read once) — and a leg is announced only while its lease is held.
 */
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  MemorySaver,
  emptyCheckpoint,
  type Checkpoint,
  type CheckpointTuple,
} from "@langchain/langgraph";
import { describe, expect, it, vi } from "vitest";
import {
  hasStartedWriting,
  LeasedCheckpointSaver,
  OrderedCheckpointSaver,
} from "../../src/app/leased-checkpointer.js";
import { OUT_OF_ORDER } from "../../src/app/checkpoint-keys.js";

const thread = (id = "thread-1", namespace = ""): RunnableConfig => ({
  configurable: { thread_id: id, checkpoint_ns: namespace },
});

const checkpointOf = (
  id: string,
  step = 0,
): [Checkpoint, { source: "loop"; step: number; parents: Record<string, never> }] => [
  { ...emptyCheckpoint(), id, channel_values: { step }, channel_versions: { step } },
  { source: "loop", step, parents: {} },
];

/** A saver over LangGraph's memory that logs every call the application's checkpointer makes of it. */
class LoggingSaver extends MemorySaver {
  readonly log: string[] = [];
  readonly listed: unknown[] = [];

  override getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const namespace = String(config.configurable?.checkpoint_ns ?? "");
    const id = config.configurable?.checkpoint_id;
    this.log.push(
      `get:${String(config.configurable?.thread_id)}:${namespace}${id === undefined ? "" : `@${String(id)}`}`,
    );
    return super.getTuple(config);
  }

  override list(config: RunnableConfig, options?: Parameters<MemorySaver["list"]>[1]) {
    this.log.push("list");
    this.listed.push(options);
    return super.list(config, options);
  }

  override put(...args: Parameters<MemorySaver["put"]>) {
    this.log.push(
      `put:${String(args[0].configurable?.thread_id)}:${String(args[0].configurable?.checkpoint_ns ?? "")}:${args[1].id}`,
    );
    return super.put(...args);
  }

  override putWrites(...args: Parameters<MemorySaver["putWrites"]>) {
    this.log.push("putWrites");
    return super.putWrites(...args);
  }

  override deleteThread(threadId: string) {
    this.log.push(`delete:${threadId}`);
    return super.deleteThread(threadId);
  }
}

/** The saver that reads its newest checkpoint by an index (#962). */
class IndexedSaver extends LoggingSaver {
  async latestByStep(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    this.log.push(`latestByStep:${String(config.configurable?.checkpoint_ns ?? "")}`);
    const all: CheckpointTuple[] = [];
    for await (const tuple of MemorySaver.prototype.list.call(this, config)) all.push(tuple);
    const step = (tuple: CheckpointTuple): number => Number(tuple.metadata?.step);
    return all.sort((first, second) => step(second) - step(first))[0];
  }
}

/** The namespaces the saver itself lists under `config`. */
async function listedFrom(saver: MemorySaver, config: RunnableConfig): Promise<string[]> {
  const namespaces: string[] = [];
  for await (const tuple of MemorySaver.prototype.list.call(saver, config))
    namespaces.push(String(tuple.config.configurable?.checkpoint_ns));
  return namespaces;
}

async function put(saver: BaseCheckpointSaver, parent: RunnableConfig, id: string, step: number) {
  const [checkpoint, metadata] = checkpointOf(id, step);
  return saver.put(parent, checkpoint, metadata, {});
}

describe("#1366: a checkpoint is written only after the lease was renewed", () => {
  function leasedOf() {
    const events: string[] = [];
    const inner = new LoggingSaver();
    const put = inner.put.bind(inner);
    const putWrites = inner.putWrites.bind(inner);
    inner.put = (...args) => {
      events.push("put");
      return put(...args);
    };
    inner.putWrites = (...args) => {
      events.push("putWrites");
      return putWrites(...args);
    };
    const renew = vi.fn(() => {
      events.push("renew");
      return Promise.resolve();
    });
    const lease = { renew } as never;
    return { events, inner, renew, lease, leased: new LeasedCheckpointSaver(inner, lease) };
  }

  it("put: the renewal first, then the write — whose result is the saver's", async () => {
    const { events, leased } = leasedOf();
    const [checkpoint, metadata] = checkpointOf("c-1");

    const config = await leased.put(thread(), checkpoint, metadata, {});

    expect(events).toEqual(["renew", "put"]);
    expect(config.configurable?.checkpoint_id).toBe("c-1");
  });

  it("putWrites: the renewal first, then the write", async () => {
    const { events, leased, inner } = leasedOf();

    await leased.putWrites(
      { configurable: { thread_id: "t", checkpoint_ns: "", checkpoint_id: "c-1" } },
      [["ch", 1]],
      "task-1",
    );

    expect(events).toEqual(["renew", "putWrites"]);
    expect(inner.log).toContain("putWrites");
  });

  it("a lease that cannot be renewed: nothing is written, the refusal is the caller's", async () => {
    const { events, leased, renew } = leasedOf();
    renew.mockRejectedValue(new Error("the lease was lost"));
    const [checkpoint, metadata] = checkpointOf("c-1");

    await expect(leased.put(thread(), checkpoint, metadata, {})).rejects.toThrow(
      "the lease was lost",
    );
    await expect(leased.putWrites(thread(), [["ch", 1]], "task-1")).rejects.toThrow(
      "the lease was lost",
    );

    expect(events).toEqual([]);
  });

  it("a read, a listing, a delete and the next version are the saver's own: the lease is not asked", async () => {
    const { leased, renew, inner } = leasedOf();
    await put(inner, thread(), "c-1", 0);
    inner.log.length = 0;

    expect((await leased.getTuple(thread()))?.checkpoint.id).toBe("c-1");
    const ids: string[] = [];
    for await (const tuple of leased.list(thread())) ids.push(tuple.checkpoint.id);
    expect(ids).toEqual(["c-1"]);
    expect(leased.getNextVersion(undefined)).toBe(inner.getNextVersion(undefined));
    expect(leased.getNextVersion(3)).toBe(inner.getNextVersion(3));
    await leased.deleteThread("thread-1");

    expect(inner.log).toEqual(["get:thread-1:", "list", "delete:thread-1"]);
    expect(renew).not.toHaveBeenCalled();
    expect(await inner.getTuple(thread())).toBeUndefined();
  });

  it("the serde is the saver's", () => {
    const { inner, leased } = leasedOf();

    expect(leased.serde).toBe(inner.serde);
  });

  it("the lease of a holder that began writing is known — before the answer, answered or not; no other lease, no undefined", async () => {
    const { leased, lease, renew } = leasedOf();
    const other = {} as never;
    expect(hasStartedWriting(lease)).toBe(false);
    expect(hasStartedWriting(undefined)).toBe(false);

    const [checkpoint, metadata] = checkpointOf("c-1");
    renew.mockRejectedValueOnce(new Error("lost"));
    await leased.put(thread(), checkpoint, metadata, {}).catch(() => undefined);
    expect(hasStartedWriting(lease)).toBe(true);
    expect(hasStartedWriting(other)).toBe(false);
  });

  it("no lease is not looked up at all: nothing is asked of the set of holders", () => {
    const has = vi.spyOn(WeakSet.prototype, "has");

    expect(hasStartedWriting(undefined)).toBe(false);
    const calls = has.mock.calls.length;
    has.mockRestore();

    expect(calls).toBe(0);
  });

  it("a holder that began with putWrites has started writing too", async () => {
    const { leased, lease } = leasedOf();
    expect(hasStartedWriting(lease)).toBe(false);

    await leased.putWrites(thread(), [["ch", 1]], "task-1").catch(() => undefined);

    expect(hasStartedWriting(lease)).toBe(true);
  });
});

describe("#1165: the ordered checkpointer's round trips", () => {
  it("a read of an unmarked thread: one look for the mark, the saver's own read — and what it saw is the floor of the next put", async () => {
    const saver = new LoggingSaver();
    const ordered = new OrderedCheckpointSaver(saver);
    await put(saver, await put(saver, thread(), "b-1", 0), "b-2", 1);
    saver.log.length = 0;

    expect((await ordered.getTuple(thread()))?.checkpoint.id).toBe("b-2");
    expect(saver.log).toEqual([`get:thread-1:${OUT_OF_ORDER}`, "get:thread-1:"]);
    saver.log.length = 0;

    // the floor is known from the read: no second read of it, and a lower id still marks
    await put(ordered, thread(), "a-1", 2);
    expect(saver.log).toEqual([
      `get:thread-1:${OUT_OF_ORDER}`,
      `put:thread-1:${OUT_OF_ORDER}:${saver.log[1]?.split(":").at(-1) ?? ""}`,
      "put:thread-1::a-1",
    ]);
  });

  it("a read of a thread with no checkpoint is undefined and sees nothing", async () => {
    const saver = new LoggingSaver();
    const ordered = new OrderedCheckpointSaver(saver);

    expect(await ordered.getTuple(thread())).toBeUndefined();
    expect(saver.log).toEqual([`get:thread-1:${OUT_OF_ORDER}`, "get:thread-1:"]);
  });

  it("a read by id is the saver's, with no look for a mark", async () => {
    const saver = new LoggingSaver();
    const ordered = new OrderedCheckpointSaver(saver);
    await put(saver, thread(), "b-1", 0);
    saver.log.length = 0;

    const config = {
      configurable: { thread_id: "thread-1", checkpoint_ns: "", checkpoint_id: "b-1" },
    };
    expect((await ordered.getTuple(config))?.checkpoint.id).toBe("b-1");

    expect(saver.log).toEqual(["get:thread-1:@b-1"]);
  });

  it("a put on a thread whose latest the saver holds reads the floor once, then knows it", async () => {
    const saver = new LoggingSaver();
    const ordered = new OrderedCheckpointSaver(saver);
    await put(saver, thread(), "b-1", 0);
    saver.log.length = 0;

    await put(ordered, thread(), "b-2", 1);
    await put(ordered, thread(), "b-3", 2);

    expect(saver.log).toEqual(["get:thread-1:", "put:thread-1::b-2", "put:thread-1::b-3"]);
  });

  it("an id equal to the floor (a retried write) marks nothing", async () => {
    const saver = new LoggingSaver();
    const ordered = new OrderedCheckpointSaver(saver);
    await put(ordered, thread(), "b-1", 0);
    saver.log.length = 0;

    await put(ordered, thread(), "b-1", 0);

    expect(saver.log).toEqual(["put:thread-1::b-1"]);
    expect(await saver.getTuple(thread("thread-1", OUT_OF_ORDER))).toBeUndefined();
  });

  it("a lower id marks the thread once, before the checkpoint; a marked thread's puts read no floor and mark no more", async () => {
    const saver = new LoggingSaver();
    const ordered = new OrderedCheckpointSaver(saver);
    await put(ordered, thread(), "b-2", 1);
    saver.log.length = 0;

    await put(ordered, thread(), "a-1", 2);
    expect(saver.log.filter((entry) => entry.startsWith("put:"))).toEqual([
      expect.stringContaining(`put:thread-1:${OUT_OF_ORDER}:`),
      "put:thread-1::a-1",
    ]);
    expect(saver.log.slice(0, 1)).toEqual([`get:thread-1:${OUT_OF_ORDER}`]);
    saver.log.length = 0;

    await put(ordered, thread(), "a-0", 3);
    expect(saver.log).toEqual(["put:thread-1::a-0"]);
  });

  it("the mark is a checkpoint of its own namespace: step -1, source update, no parents", async () => {
    const saver = new LoggingSaver();
    const ordered = new OrderedCheckpointSaver(saver);
    await put(ordered, thread(), "b-2", 1);
    await put(ordered, thread(), "a-1", 2);

    const mark = await saver.getTuple(thread("thread-1", OUT_OF_ORDER));

    expect(mark?.metadata).toEqual({ source: "update", step: -1, parents: {} });
  });

  it("a mark another instance wrote is found once, then remembered", async () => {
    const saver = new LoggingSaver();
    const writer = new OrderedCheckpointSaver(saver);
    await put(writer, await put(writer, thread(), "b-2", 1), "a-1", 2);
    const reader = new OrderedCheckpointSaver(saver);
    saver.log.length = 0;

    expect((await reader.getTuple(thread()))?.checkpoint.id).toBe("a-1");
    expect((await reader.getTuple(thread()))?.checkpoint.id).toBe("a-1");

    expect(saver.log.filter((entry) => entry === `get:thread-1:${OUT_OF_ORDER}`)).toHaveLength(1);
  });

  it("a thread known unmarked is looked at again for its mark on each read", async () => {
    const saver = new LoggingSaver();
    const ordered = new OrderedCheckpointSaver(saver);
    await put(saver, thread(), "b-1", 0);
    saver.log.length = 0;

    await ordered.getTuple(thread());
    await ordered.getTuple(thread());

    expect(saver.log.filter((entry) => entry === `get:thread-1:${OUT_OF_ORDER}`)).toHaveLength(2);
  });

  it("the latest of a marked thread is read by an index when the saver has one, else by the sorted list", async () => {
    const indexed = new IndexedSaver();
    const listing = new LoggingSaver();
    for (const saver of [indexed, listing]) {
      const ordered = new OrderedCheckpointSaver(saver);
      await put(ordered, await put(ordered, thread(), "b-2", 1), "a-1", 2);
      saver.log.length = 0;

      expect((await ordered.getTuple(thread()))?.checkpoint.id).toBe("a-1");
    }

    expect(indexed.log).toContain("latestByStep:");
    expect(indexed.log).not.toContain("list");
    expect(listing.log).toContain("list");
    expect(listing.log.some((entry) => entry.startsWith("latestByStep"))).toBe(false);
  });

  it("a marked thread whose only checkpoint is the mark has no latest", async () => {
    const saver = new IndexedSaver();
    const ordered = new OrderedCheckpointSaver(saver);
    await put(saver, thread("thread-1", OUT_OF_ORDER), "mark-1", -1);

    expect(await ordered.getTuple(thread())).toBeUndefined();
    const listing = new LoggingSaver();
    await put(listing, thread("thread-1", OUT_OF_ORDER), "mark-1", -1);
    expect(await new OrderedCheckpointSaver(listing).getTuple(thread())).toBeUndefined();
  });

  it("the floor of one namespace is not the floor of another", async () => {
    const saver = new LoggingSaver();
    const ordered = new OrderedCheckpointSaver(saver);
    await put(ordered, thread("thread-1", "child"), "b-2", 1);

    await put(ordered, thread("thread-1", ""), "a-1", 0);

    expect(await saver.getTuple(thread("thread-1", OUT_OF_ORDER))).toBeUndefined();
  });

  it("an unmarked list is the saver's, its options as given; the mark's namespace never listed", async () => {
    const saver = new LoggingSaver();
    const ordered = new OrderedCheckpointSaver(saver);
    await put(saver, await put(saver, thread(), "b-1", 0), "b-2", 1);
    saver.log.length = 0;
    saver.listed.length = 0;

    const ids: string[] = [];
    for await (const tuple of ordered.list(thread(), { limit: 1 })) ids.push(tuple.checkpoint.id);

    expect(ids).toEqual(["b-2"]);
    expect(saver.listed).toEqual([{ limit: 1 }]);
  });

  it("an unmarked list leaves out a mark another instance wrote while it looked", async () => {
    class RacingSaver extends LoggingSaver {
      calls = 0;
      override getTuple(config: RunnableConfig) {
        if (String(config.configurable?.checkpoint_ns ?? "") === OUT_OF_ORDER) {
          this.calls += 1;
          // the mark is not there at the look, and there at the listing
          if (this.calls === 1) return Promise.resolve(undefined);
        }
        return super.getTuple(config);
      }
    }
    const saver = new RacingSaver();
    await put(saver, thread(), "b-1", 0);
    await put(saver, thread("thread-1", OUT_OF_ORDER), "mark-1", -1);
    const ordered = new OrderedCheckpointSaver(saver);

    const ids: string[] = [];
    for await (const tuple of ordered.list(thread())) ids.push(tuple.checkpoint.id);

    expect(ids).toEqual(["b-1"]);
  });

  it("a list of a thread whose config names no namespace leaves out the mark, marked or not", async () => {
    const saver = new LoggingSaver();
    const ordered = new OrderedCheckpointSaver(saver);
    await put(ordered, await put(ordered, thread(), "b-2", 1), "a-1", 2);
    const anyNamespace: RunnableConfig = { configurable: { thread_id: "thread-1" } };

    const marked: string[] = [];
    for await (const tuple of ordered.list(anyNamespace)) marked.push(tuple.checkpoint.id);
    expect(marked).toEqual(["a-1", "b-2"]);
    expect(await listedFrom(saver, anyNamespace)).toContain(OUT_OF_ORDER);

    // another instance, the mark not there at its look and there at its listing
    class RacingSaver extends LoggingSaver {
      calls = 0;
      override getTuple(config: RunnableConfig) {
        if (String(config.configurable?.checkpoint_ns ?? "") === OUT_OF_ORDER) {
          this.calls += 1;
          if (this.calls === 1) return Promise.resolve(undefined);
        }
        return super.getTuple(config);
      }
    }
    const racing = new RacingSaver();
    await put(racing, thread(), "b-1", 0);
    await put(racing, thread("thread-1", OUT_OF_ORDER), "mark-1", -1);
    const ids: string[] = [];
    for await (const tuple of new OrderedCheckpointSaver(racing).list(anyNamespace))
      ids.push(tuple.checkpoint.id);
    expect(ids).toEqual(["b-1"]);
  });

  it("a thread learned marked on a read needs no floor on its next put: only the write", async () => {
    const saver = new LoggingSaver();
    const writer = new OrderedCheckpointSaver(saver);
    await put(writer, await put(writer, thread(), "b-2", 1), "a-1", 2);
    const fresh = new OrderedCheckpointSaver(saver);
    expect((await fresh.getTuple(thread()))?.checkpoint.id).toBe("a-1");
    saver.log.length = 0;

    await put(fresh, thread(), "a-0", 3);

    expect(saver.log).toEqual(["put:thread-1::a-0"]);
  });

  it("a marked list is by step newest first, the limit applied after sorting, the saver asked with every option but the limit", async () => {
    const saver = new LoggingSaver();
    const ordered = new OrderedCheckpointSaver(saver);
    await put(
      ordered,
      await put(ordered, await put(ordered, thread(), "c-3", 2), "b-2", 1),
      "a-1",
      3,
    );
    saver.log.length = 0;
    saver.listed.length = 0;

    const ids: string[] = [];
    for await (const tuple of ordered.list(thread(), { limit: 2, filter: { source: "loop" } }))
      ids.push(tuple.checkpoint.id);

    expect(ids).toEqual(["a-1", "c-3"]);
    expect(saver.listed).toEqual([{ limit: undefined, filter: { source: "loop" } }]);
  });

  it("a marked list with no limit is whole; the mark's own namespace is never in it", async () => {
    const saver = new LoggingSaver();
    const ordered = new OrderedCheckpointSaver(saver);
    await put(ordered, await put(ordered, thread(), "b-2", 1), "a-1", 2);

    const ids: string[] = [];
    for await (const tuple of ordered.list(thread())) ids.push(tuple.checkpoint.id);

    expect(ids).toEqual(["a-1", "b-2"]);
  });

  it("the write of a pending write, the next version and the serde are the saver's", async () => {
    const saver = new LoggingSaver();
    const ordered = new OrderedCheckpointSaver(saver);
    const config = await put(ordered, thread(), "b-1", 0);

    await ordered.putWrites(config, [["ch", 1]], "task-1");

    expect(saver.log).toContain("putWrites");
    expect(ordered.getNextVersion(2)).toBe(saver.getNextVersion(2));
    expect(ordered.getNextVersion(undefined)).toBe(saver.getNextVersion(undefined));
    expect(ordered.serde).toBe(saver.serde);
  });

  it("a thread deleted is forgotten whole — its mark and its floor — and no other thread's, whatever its namespace", async () => {
    const saver = new LoggingSaver();
    const ordered = new OrderedCheckpointSaver(saver);
    await put(ordered, await put(ordered, thread("a", "child"), "b-2", 1), "a-1", 2);
    await put(ordered, thread("ab", "child"), "z-1", 5);
    await put(ordered, thread("a", ""), "q-5", 0);

    await ordered.deleteThread("a");
    expect(saver.log).toContain("delete:a");
    saver.log.length = 0;

    // "a" is a new thread: its mark and floors are gone — a lower id is no step back
    await put(ordered, thread("a", "child"), "a-0", 0);
    expect(saver.log).toEqual(["get:a:child", "put:a:child:a-0"]);
    expect(await saver.getTuple(thread("a", OUT_OF_ORDER))).toBeUndefined();
    saver.log.length = 0;

    // "ab" is another thread: its floor is still known
    await put(ordered, thread("ab", "child"), "z-2", 6);
    expect(saver.log).toEqual(["put:ab:child:z-2"]);
  });

  it("a thread deleted is read as unmarked: the saver is looked at for a mark again", async () => {
    const saver = new LoggingSaver();
    const ordered = new OrderedCheckpointSaver(saver);
    await put(ordered, await put(ordered, thread(), "b-2", 1), "a-1", 2);
    expect((await ordered.getTuple(thread()))?.checkpoint.id).toBe("a-1");

    await ordered.deleteThread("thread-1");
    saver.log.length = 0;

    expect(await ordered.getTuple(thread())).toBeUndefined();
    expect(saver.log).toEqual([`get:thread-1:${OUT_OF_ORDER}`, "get:thread-1:"]);
  });

  it("the floor is the greatest id seen: a read that finds an older latest (pruned) lowers nothing", async () => {
    class PrunedSaver extends LoggingSaver {
      served: CheckpointTuple | undefined;
      override async getTuple(config: RunnableConfig) {
        if (this.served !== undefined && config.configurable?.checkpoint_ns === "")
          return this.served;
        return super.getTuple(config);
      }
    }
    const saver = new PrunedSaver();
    const ordered = new OrderedCheckpointSaver(saver);
    await put(ordered, thread(), "m-5", 1);
    const older = await saver.getTuple(thread());
    if (older === undefined) throw new Error("the first checkpoint was not stored");
    expect(older.checkpoint.id).toBe("m-5");
    saver.served = { ...older, checkpoint: { ...older.checkpoint, id: "c-1" } };

    expect((await ordered.getTuple(thread()))?.checkpoint.id).toBe("c-1");
    saver.served = undefined;

    // m-5 is still the greatest id stored: an id below it, above c-1, is a step back
    await put(ordered, thread(), "f-3", 2);
    expect(await saver.getTuple(thread("thread-1", OUT_OF_ORDER))).toBeDefined();
  });
});
