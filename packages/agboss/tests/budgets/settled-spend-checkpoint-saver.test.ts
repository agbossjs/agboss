/**
 * #776 — a pass's checkpointer writes a state only once the spend it tallied is in the ledger
 * (#727, #732, `SettledSpendCheckpointSaver`): `put` and `putWrites` wait for `settled()` and fail
 * with it, writing nothing; every read, a thread's delete and the next version are the saver's own.
 * `settledSaverOf` wraps a checkpointer, and gives none without one.
 */
import type { RunnableConfig } from "@langchain/core/runnables";
import { MemorySaver, emptyCheckpoint } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import { SettledSpendCheckpointSaver, settledSaverOf } from "../../src/app/leased-checkpointer.js";

const thread = (id = "thread-1"): RunnableConfig => ({
  configurable: { thread_id: id, checkpoint_ns: "" },
});

/** A pass's `settled()`, resolved (or rejected) when the test says. */
function heldSpend(): {
  readonly spend: { readonly settled: () => Promise<void> };
  readonly land: () => void;
  readonly fail: (error: Error) => void;
  readonly calls: () => number;
} {
  let calls = 0;
  let land = (): void => undefined;
  let fail = (_error: Error): void => undefined;
  const pending = new Promise<void>((resolve, reject) => {
    land = resolve;
    fail = reject;
  });
  pending.catch(() => undefined);
  return {
    spend: {
      settled: () => {
        calls += 1;
        return pending;
      },
    },
    land,
    fail,
    calls: () => calls,
  };
}

const put = (saver: MemorySaver | SettledSpendCheckpointSaver, id: string, config = thread()) =>
  saver.put(
    config,
    { ...emptyCheckpoint(), id, channel_values: { step: 0 }, channel_versions: { step: 1 } },
    { source: "loop", step: 0, parents: {} },
    {},
  );

/** Whether `promise` has settled after the microtasks queued so far ran. */
async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  return settled;
}

describe("#776: SettledSpendCheckpointSaver writes once the pass's spend is in the ledger", () => {
  it("put waits for settled(), then writes through the saver and returns its config", async () => {
    const saver = new MemorySaver();
    const held = heldSpend();
    const settledSaver = new SettledSpendCheckpointSaver(saver, held.spend);

    const written = put(settledSaver, "c-1");
    expect(await isSettled(written)).toBe(false);
    expect(held.calls()).toBe(1);
    expect(await saver.getTuple(thread())).toBeUndefined();

    held.land();
    expect((await written).configurable?.checkpoint_id).toBe("c-1");
    expect((await saver.getTuple(thread()))?.checkpoint.id).toBe("c-1");
  });

  it("put fails with settled(), and nothing is written", async () => {
    const saver = new MemorySaver();
    const held = heldSpend();
    const settledSaver = new SettledSpendCheckpointSaver(saver, held.spend);

    const written = put(settledSaver, "c-1");
    held.fail(new Error("the ledger write failed twice"));

    await expect(written).rejects.toThrow("the ledger write failed twice");
    expect(await saver.getTuple(thread())).toBeUndefined();
  });

  it("putWrites waits for settled(), then writes through the saver; fails with it, writing nothing", async () => {
    const saver = new MemorySaver();
    const config = await put(saver, "c-1");
    const held = heldSpend();
    const settledSaver = new SettledSpendCheckpointSaver(saver, held.spend);

    const writes = settledSaver.putWrites(config, [["step", 2]], "task-1");
    expect(await isSettled(writes)).toBe(false);
    expect((await saver.getTuple(config))?.pendingWrites).toEqual([]);
    held.land();
    await writes;
    expect((await saver.getTuple(config))?.pendingWrites).toEqual([["task-1", "step", 2]]);

    const failing = heldSpend();
    const failingSaver = new SettledSpendCheckpointSaver(saver, failing.spend);
    const refused = failingSaver.putWrites(config, [["step", 3]], "task-2");
    failing.fail(new Error("the ledger write failed twice"));
    await expect(refused).rejects.toThrow("the ledger write failed twice");
    expect((await saver.getTuple(config))?.pendingWrites).toEqual([["task-1", "step", 2]]);
  });

  it("reads, a thread's delete and the next version are the saver's, never waiting for spend", async () => {
    const saver = new MemorySaver();
    await put(saver, "c-1");
    await put(saver, "d-1", thread("thread-2"));
    const held = heldSpend();
    const settledSaver = new SettledSpendCheckpointSaver(saver, held.spend);

    expect((await settledSaver.getTuple(thread()))?.checkpoint.id).toBe("c-1");
    const listed: string[] = [];
    for await (const tuple of settledSaver.list(thread())) listed.push(tuple.checkpoint.id);
    expect(listed).toEqual(["c-1"]);
    expect(settledSaver.getNextVersion(undefined)).toBe(saver.getNextVersion(undefined));
    expect(settledSaver.getNextVersion(4)).toBe(saver.getNextVersion(4));
    expect(settledSaver.serde).toBe(saver.serde);

    await settledSaver.deleteThread("thread-1");
    expect(await saver.getTuple(thread())).toBeUndefined();
    expect((await saver.getTuple(thread("thread-2")))?.checkpoint.id).toBe("d-1");
    expect(held.calls()).toBe(0);
  });

  it("settledSaverOf wraps a checkpointer, and gives none without one", async () => {
    const saver = new MemorySaver();
    const held = heldSpend();

    expect(settledSaverOf(undefined, held.spend)).toBeUndefined();
    const wrapped = settledSaverOf(saver, held.spend);
    expect(wrapped).toBeInstanceOf(SettledSpendCheckpointSaver);
    const written = wrapped === undefined ? Promise.resolve() : put(wrapped, "c-1");
    expect(await isSettled(written)).toBe(false);
    held.land();
    await written;
    expect((await saver.getTuple(thread()))?.checkpoint.id).toBe("c-1");
  });
});
