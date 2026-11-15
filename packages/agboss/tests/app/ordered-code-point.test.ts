/**
 * #1143: `OrderedCheckpointSaver` compares checkpoint ids by code point, as the stores order them
 * (#1115): a new id in U+E000..U+FFFF after an astral id sorts below it, so the thread is marked and
 * the latest read answers by step, not by the store's id order.
 */
import type { RunnableConfig } from "@langchain/core/runnables";
import { BaseCheckpointSaver, emptyCheckpoint } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import { OrderedCheckpointSaver } from "../../src/app/leased-checkpointer.js";
import { InMemoryCheckpointSaver } from "../../src/infrastructure/contracts.js";
import { SqliteCheckpointSaver } from "../../src/infrastructure/sqlite/sqlite-checkpoint-saver.js";
import { connectionTo, temporarySqlitePath } from "../infrastructure/contracts/store-kinds.js";

const ASTRAL = "\u{10000}";
const ASTRAL_HIGH = "\u{10001}";
const HIGH_BMP = "￿";
const PRIVATE_USE = "";

const at = (thread: string): RunnableConfig => ({
  configurable: { thread_id: thread, checkpoint_ns: "" },
});

const put = (saver: BaseCheckpointSaver, thread: string, id: string, step: number) =>
  saver.put(
    at(thread),
    { ...emptyCheckpoint(), id, channel_values: { step }, channel_versions: { step } },
    { source: "loop", step, parents: {} },
    {},
  );

const stores: readonly (readonly [string, () => BaseCheckpointSaver])[] = [
  ["in-memory", () => new InMemoryCheckpointSaver()],
  ["SQLite", () => new SqliteCheckpointSaver(connectionTo(temporarySqlitePath()))],
];

describe.each(stores)("#1143 AC1: ids compare by code point on %s", (_name, make) => {
  it("a U+FFFF id written after an astral id is the latest by step", async () => {
    const store = make();
    await put(new OrderedCheckpointSaver(store), "t", ASTRAL, 1);
    await put(new OrderedCheckpointSaver(store), "t", HIGH_BMP, 2);
    const fresh = new OrderedCheckpointSaver(store);
    expect((await fresh.getTuple(at("t")))?.checkpoint.id).toBe(HIGH_BMP);
    const listed: string[] = [];
    for await (const tuple of fresh.list(at("t"))) listed.push(tuple.checkpoint.id);
    expect(listed).toEqual([HIGH_BMP, ASTRAL]);
  });

  it("the greatest id the saver tracks is the code-point greatest", async () => {
    // U+E000 < U+10000 < U+FFFF only by... code point: E000 < FFFF < 10000
    const store = make();
    const saver = new OrderedCheckpointSaver(store);
    await put(saver, "t", PRIVATE_USE, 1);
    await put(saver, "t", ASTRAL, 2); // greatest by code point
    await put(saver, "t", HIGH_BMP, 3); // below the astral id: marks the thread
    expect((await saver.getTuple(at("t")))?.checkpoint.id).toBe(HIGH_BMP);
    expect((await new OrderedCheckpointSaver(store).getTuple(at("t")))?.checkpoint.id).toBe(
      HIGH_BMP,
    );
  });

  it("an astral id after a U+FFFF id is the latest, unmarked, ids ascending by code point", async () => {
    const store = make();
    await put(new OrderedCheckpointSaver(store), "t", HIGH_BMP, 1);
    await put(new OrderedCheckpointSaver(store), "t", ASTRAL, 2);
    await put(new OrderedCheckpointSaver(store), "t", ASTRAL_HIGH, 3);
    const fresh = new OrderedCheckpointSaver(store);
    expect((await fresh.getTuple(at("t")))?.checkpoint.id).toBe(ASTRAL_HIGH);
    const listed: string[] = [];
    for await (const tuple of fresh.list(at("t"))) listed.push(tuple.checkpoint.id);
    expect(listed).toEqual([ASTRAL_HIGH, ASTRAL, HIGH_BMP]);
  });

  it("the store's list is newest first by code point; before and limit follow it", async () => {
    const store = make();
    for (const [index, id] of [PRIVATE_USE, HIGH_BMP, ASTRAL].entries())
      await put(store, "t", id, index + 1);
    const ids = async (options?: Parameters<BaseCheckpointSaver["list"]>[1]) => {
      const found: string[] = [];
      for await (const tuple of store.list(at("t"), options)) found.push(tuple.checkpoint.id);
      return found;
    };
    expect(await ids()).toEqual([ASTRAL, HIGH_BMP, PRIVATE_USE]);
    expect(await ids({ limit: 1 })).toEqual([ASTRAL]);
    expect(
      await ids({ before: { configurable: { thread_id: "t", checkpoint_id: ASTRAL } } }),
    ).toEqual([HIGH_BMP, PRIVATE_USE]);
  });
});
