/**
 * #817 — a state's usage read back from a checkpoint with each record's ledger mark as this version
 * keeps it: a checkpoint keeps JSON, so a `Date` comes back as ISO text and a record kept before
 * 0.1.1 with its three fields; the application's checkpointer (`OrderedCheckpointSaver`) gives the
 * one mark back, a `Date`, on every read — the latest, one by id, the list and the pending writes.
 * On LangGraph's `MemorySaver` and `SqliteCheckpointSaver`.
 */
import type { RunnableConfig } from "@langchain/core/runnables";
import { BaseCheckpointSaver, MemorySaver, emptyCheckpoint } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import { OrderedCheckpointSaver } from "../../src/app/leased-checkpointer.js";
import { LedgerState } from "../../src/finops/ledger-mark.js";
import { recordToolCost } from "../../src/finops/usage.js";
import { SqliteCheckpointSaver } from "../../src/infrastructure/sqlite/sqlite-checkpoint-saver.js";
import { connectionTo, temporarySqlitePath } from "../infrastructure/contracts/store-kinds.js";

const savers: readonly (readonly [string, () => BaseCheckpointSaver])[] = [
  ["in-memory", () => new MemorySaver()],
  ["SQLite", () => new SqliteCheckpointSaver(connectionTo(temporarySqlitePath()))],
];

const MADE_AT = new Date("2026-11-04T12:00:00.000Z");
const thread: RunnableConfig = { configurable: { thread_id: "thread-1", checkpoint_ns: "" } };
const paid = recordToolCost("pay-tool", 1);
const written = {
  ...paid,
  ledger: { state: LedgerState.Written, ledgerId: "p:0", madeAt: MADE_AT },
};
const elsewhere = { ...paid, ledger: { state: LedgerState.RecordedElsewhere } };
/** A record as a state of before 0.1.1 kept it. */
const legacy = {
  ...paid,
  isRecordedElsewhere: true,
  ledgerId: "p:1",
  madeAt: MADE_AT.toISOString(),
};

/** Puts a checkpoint holding `usage` (and `other`, a channel that is not usage). */
const put = (saver: BaseCheckpointSaver, usage: readonly unknown[]) =>
  saver.put(
    thread,
    {
      ...emptyCheckpoint(),
      id: "c-1",
      channel_values: { usage, other: [{ ledger: "not a mark" }] },
      channel_versions: { usage: 1, other: 1 },
    },
    { source: "loop", step: 0, parents: {} },
    {},
  );

describe.each(savers)("#817: a checkpoint's usage read back on %s", (_name, saverOf) => {
  it("the latest, by id and in the list: each mark one field, its date a Date", async () => {
    const saver = saverOf();
    const ordered = new OrderedCheckpointSaver(saver);
    const at = await put(ordered, [written, elsewhere, legacy, paid]);
    const expected = [
      written,
      elsewhere,
      { ...paid, ledger: { state: LedgerState.Written, ledgerId: "p:1", madeAt: MADE_AT } },
      paid,
    ];

    // what the saver keeps is JSON: the date is text there
    const raw = await saver.getTuple(thread);
    expect(raw?.checkpoint.channel_values.usage).not.toEqual(expected);
    expect((await ordered.getTuple(thread))?.checkpoint.channel_values.usage).toEqual(expected);
    expect((await ordered.getTuple(at))?.checkpoint.channel_values.usage).toEqual(expected);
    for await (const tuple of ordered.list(thread))
      expect(tuple.checkpoint.channel_values.usage).toEqual(expected);
    // another channel is as it was kept
    expect((await ordered.getTuple(thread))?.checkpoint.channel_values.other).toEqual([
      { ledger: "not a mark" },
    ]);
  });

  it("the pending writes to the usage channel are read the same; others as they were", async () => {
    const saver = saverOf();
    const ordered = new OrderedCheckpointSaver(saver);
    const at = await put(ordered, []);
    await ordered.putWrites(
      at,
      [
        ["usage", [written]],
        ["other", [{ ledger: { state: LedgerState.Written } }]],
      ],
      "task-1",
    );

    const writes = (await ordered.getTuple(thread))?.pendingWrites ?? [];
    expect(writes).toContainEqual(["task-1", "usage", [written]]);
    expect(writes).toContainEqual(["task-1", "other", [{ ledger: { state: "written" } }]]);
  });

  it("a mark this version does not read fails the read: the state is never continued", async () => {
    const saver = saverOf();
    const ordered = new OrderedCheckpointSaver(saver);
    await put(ordered, [{ ...paid, ledger: { state: "written-somewhere" } }]);

    await expect(ordered.getTuple(thread)).rejects.toThrow(TypeError);
  });
});
