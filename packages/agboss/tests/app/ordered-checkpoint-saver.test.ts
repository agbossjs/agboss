/**
 * #682 — the application's checkpointer reads a thread's latest checkpoint as the one written last,
 * whatever order the ids sort in: LangGraph's ids are UUIDv6 of the wall clock, so after the host's
 * clock steps back a newer checkpoint's id sorts first. On LangGraph's `MemorySaver` (the in-memory
 * default) and `SqliteCheckpointSaver`; PostgreSQL runs the same in agbossjs/postgres.
 */
import type { RunnableConfig } from "@langchain/core/runnables";
import { BaseCheckpointSaver, MemorySaver, emptyCheckpoint } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import { OrderedCheckpointSaver, OUT_OF_ORDER } from "../../src/app/leased-checkpointer.js";
import { SqliteCheckpointSaver } from "../../src/infrastructure/sqlite/sqlite-checkpoint-saver.js";
import { connectionTo, temporarySqlitePath } from "../infrastructure/contracts/store-kinds.js";
import { infrastructureOf } from "../../src/infrastructure/contracts.js";

const savers: readonly (readonly [string, () => BaseCheckpointSaver])[] = [
  ["in-memory", () => new MemorySaver()],
  ["SQLite", () => new SqliteCheckpointSaver(connectionTo(temporarySqlitePath()))],
];

const thread = (namespace = ""): RunnableConfig => ({
  configurable: { thread_id: "thread-1", checkpoint_ns: namespace },
});

/** Puts checkpoint `id` at LangGraph step `step` after `parent` (the config `put` returned). */
const put = (saver: BaseCheckpointSaver, parent: RunnableConfig, id: string, step: number) =>
  saver.put(
    parent,
    { ...emptyCheckpoint(), id, channel_values: { step }, channel_versions: { step } },
    { source: "loop", step, parents: {} },
    {},
  );

async function idsOf(saver: BaseCheckpointSaver, config: RunnableConfig): Promise<string[]> {
  const ids: string[] = [];
  for await (const tuple of saver.list(config)) ids.push(tuple.checkpoint.id);
  return ids;
}

describe.each(savers)("#682: the ordered checkpointer on %s", (_name, saverOf) => {
  it("ids in time order: the thread is read as the saver reads it, no mark", async () => {
    const saver = saverOf();
    const ordered = new OrderedCheckpointSaver(saver);
    await put(ordered, await put(ordered, thread(), "b-1", 0), "b-2", 1);

    expect((await ordered.getTuple(thread()))?.checkpoint.id).toBe("b-2");
    expect(await saver.getTuple(thread(OUT_OF_ORDER))).toBeUndefined();
    expect(await idsOf(ordered, thread())).toEqual(["b-2", "b-1"]);
  });

  it("a checkpoint whose id sorts first after a step back: the latest is the one written last", async () => {
    const saver = saverOf();
    const ordered = new OrderedCheckpointSaver(saver);
    const second = await put(ordered, await put(ordered, thread(), "b-1", 0), "b-2", 1);
    // the wall clock stepped back: the next ids sort before b-2
    await put(ordered, await put(ordered, second, "a-1", 2), "a-2", 3);

    expect(await saver.getTuple(thread())).toMatchObject({ checkpoint: { id: "b-2" } });
    expect((await ordered.getTuple(thread()))?.checkpoint.id).toBe("a-2");
    expect(await idsOf(ordered, thread())).toEqual(["a-2", "a-1", "b-2", "b-1"]);
    // another instance over the same store reads the same
    const other = new OrderedCheckpointSaver(saver);
    expect((await other.getTuple(thread()))?.checkpoint.id).toBe("a-2");
    expect((await other.getTuple({ configurable: { thread_id: "thread-1" } }))?.checkpoint.id).toBe(
      "a-2",
    );
    // a read by id is the saver's
    expect(
      (
        await other.getTuple({
          ...thread(),
          configurable: { ...thread().configurable, checkpoint_id: "b-1" },
        })
      )?.checkpoint.id,
    ).toBe("b-1");
  });

  it("another instance's write out of order is seen by the first instance's next read", async () => {
    const saver = saverOf();
    const first = new OrderedCheckpointSaver(saver);
    const second = await put(first, await put(first, thread(), "b-1", 0), "b-2", 1);
    expect((await first.getTuple(thread()))?.checkpoint.id).toBe("b-2");
    const other = new OrderedCheckpointSaver(saver);
    await put(other, second, "a-1", 2);

    expect((await first.getTuple(thread()))?.checkpoint.id).toBe("a-1");
  });
});

describe("#682: no read of a thread's greatest id", () => {
  it.each(savers)("the application's checkpointer over %s is the ordered one", (_name, saverOf) => {
    const listed = saverOf();
    const infrastructure = infrastructureOf((contract) =>
      contract === BaseCheckpointSaver ? listed : undefined,
    );

    expect(infrastructure.checkpointer).toBeInstanceOf(OrderedCheckpointSaver);
    expect((infrastructure.checkpointer as OrderedCheckpointSaver).saver).toBe(listed);
  });
});
