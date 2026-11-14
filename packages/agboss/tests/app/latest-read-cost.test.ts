/**
 * #962 AC1: on a marked thread of 10 000 checkpoints the latest read does not list the namespace —
 * the calls the checkpointer makes of its saver are counted, per store; without the capability the
 * scan is the same answer.
 */
import type { RunnableConfig } from "@langchain/core/runnables";
import { BaseCheckpointSaver, emptyCheckpoint, type CheckpointTuple } from "@langchain/langgraph";
import { describe, expect, it, vi } from "vitest";
import { OrderedCheckpointSaver } from "../../src/app/leased-checkpointer.js";
import { OUT_OF_ORDER } from "../../src/app/checkpoint-keys.js";
import { InMemoryCheckpointSaver } from "../../src/infrastructure/contracts.js";
import { hasLatestByStep } from "../../src/infrastructure/latest-by-step.js";
import { LATEST_BY_STEP_SQL } from "../../src/infrastructure/sqlite/sqlite-checkpoint-rows.js";
import { SqliteCheckpointSaver } from "../../src/infrastructure/sqlite/sqlite-checkpoint-saver.js";
import { connectionTo, temporarySqlitePath } from "../infrastructure/contracts/store-kinds.js";

// 10 000 puts through the checkpointer: a loaded CI machine needs more than the default 5 s
vi.setConfig({ testTimeout: 60_000 });

const CHECKPOINTS = 10_000;
const thread: RunnableConfig = { configurable: { thread_id: "busy", checkpoint_ns: "" } };

/** A saver's calls, by method name. */
class Counting extends BaseCheckpointSaver {
  readonly calls: string[] = [];
  constructor(readonly inner: BaseCheckpointSaver) {
    super(inner.serde);
  }
  getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    this.calls.push("getTuple");
    return this.inner.getTuple(config);
  }
  list(...args: Parameters<BaseCheckpointSaver["list"]>): AsyncGenerator<CheckpointTuple> {
    this.calls.push("list");
    return this.inner.list(...args);
  }
  put(...args: Parameters<BaseCheckpointSaver["put"]>): Promise<RunnableConfig> {
    return this.inner.put(...args);
  }
  putWrites(...args: Parameters<BaseCheckpointSaver["putWrites"]>): Promise<void> {
    return this.inner.putWrites(...args);
  }
  deleteThread(threadId: string): Promise<void> {
    return this.inner.deleteThread(threadId);
  }
}

/** The same, forwarding `latestByStep` of a saver that has it. */
class CountingLatest extends Counting {
  latestByStep(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    this.calls.push("latestByStep");
    if (!hasLatestByStep(this.inner)) return Promise.reject(new Error("no latestByStep"));
    return this.inner.latestByStep(config);
  }
}

/** 10 000 checkpoints of one thread; the 5 000th's id sorts first (the clock stepped back). */
async function markedThread(saver: BaseCheckpointSaver): Promise<string> {
  let parent = thread;
  let newest = "";
  for (let step = 0; step < CHECKPOINTS; step += 1) {
    newest = `${step < CHECKPOINTS / 2 ? "b" : "a"}-${String(step).padStart(5, "0")}`;
    parent = await saver.put(
      parent,
      { ...emptyCheckpoint(), id: newest },
      { source: "loop", step, parents: {} },
      {},
    );
  }
  return newest;
}

const stores: readonly (readonly [
  string,
  () => InMemoryCheckpointSaver | SqliteCheckpointSaver,
])[] = [
  ["in-memory", () => new InMemoryCheckpointSaver()],
  ["SQLite", () => new SqliteCheckpointSaver(connectionTo(temporarySqlitePath()))],
];

describe.each(stores)("#962 AC1: the latest read of a marked thread on %s", (_name, make) => {
  it("AC1: 10 000 checkpoints — one latestByStep and one mark look, no list; later reads one call", async () => {
    const store = make();
    const counted = new CountingLatest(store);
    const ordered = new OrderedCheckpointSaver(counted);
    const newest = await markedThread(ordered);
    expect(
      await store.getTuple({ configurable: { thread_id: "busy", checkpoint_ns: OUT_OF_ORDER } }),
    ).toBeDefined();
    counted.calls.length = 0;

    expect((await ordered.getTuple(thread))?.checkpoint.id).toBe(newest);
    expect(counted.calls).toEqual(["latestByStep"]);
    counted.calls.length = 0;
    expect((await ordered.getTuple(thread))?.checkpoint.id).toBe(newest);
    expect(counted.calls).toEqual(["latestByStep"]);
  });

  it("AC1: a saver without the capability reads the same checkpoint by the scan (one list)", async () => {
    const store = make();
    const plain = new Counting(store);
    const ordered = new OrderedCheckpointSaver(plain);
    const newest = await markedThread(ordered);
    plain.calls.length = 0;

    expect((await ordered.getTuple(thread))?.checkpoint.id).toBe(newest);
    expect(plain.calls).toContain("list");
  });

  it("AC1: an unmarked thread reads as before: its saver's latest, one mark look, no scan", async () => {
    const counted = new CountingLatest(make());
    const ordered = new OrderedCheckpointSaver(counted);
    await ordered.put(
      thread,
      { ...emptyCheckpoint(), id: "a-1" },
      { source: "loop", step: 0, parents: {} },
      {},
    );
    counted.calls.length = 0;

    expect((await ordered.getTuple(thread))?.checkpoint.id).toBe("a-1");
    expect(counted.calls).toEqual(["getTuple", "getTuple"]);
  });
});

describe("#962 AC1: SQLite's latestByStep is one walk of its index", () => {
  it("AC1: the query plan uses checkpoints_latest_by_step, with no sort and no scan", () => {
    const connection = connectionTo(temporarySqlitePath());
    new SqliteCheckpointSaver(connection);

    const plan = connection.database
      .prepare(`EXPLAIN QUERY PLAN ${LATEST_BY_STEP_SQL}`)
      .all("busy", "")
      .map((row) => String(row.detail));

    expect(plan.join(" | ")).toMatch(/USING (COVERING )?INDEX checkpoints_latest_by_step/);
    expect(plan.join(" | ")).not.toMatch(/SCAN|TEMP B-TREE/);
  });
});
