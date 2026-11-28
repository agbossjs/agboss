/** #1281 (10), #1356 (WP6, unwind shard): the held entries a failure undoes before its side path, and how the update takes them. */
import { describe, expect, it } from "vitest";
import { CompensationEntryStatus } from "../../../src/flow/compensation.js";
import {
  heldEntriesUndone,
  withHeldUndone,
} from "../../../src/flow/runtime/compensation/held-on-error.js";
import { entryOf } from "./fixtures/compensation-entries.js";

const usageOf = (id: string) => ({ id }) as never;

describe("heldEntriesUndone", () => {
  it("undoes nothing, and loads nothing, when no entry is held open to the execution", async () => {
    const site = {
      state: {
        compensations: [
          entryOf("own"),
          entryOf("closed-held", {
            executionId: "child-1",
            heldBy: "root-1",
            childPath: ["trip"],
            status: CompensationEntryStatus.Closed,
          }),
          entryOf("held-by-another", {
            executionId: "child-1",
            heldBy: "other",
            childPath: ["trip"],
          }),
        ],
      },
      frame: { execution: { executionId: "root-1" } },
    } as never;

    expect(await heldEntriesUndone(site)).toBeUndefined();
  });
});

describe("withHeldUndone", () => {
  it("is the update itself when nothing was held", () => {
    const update = { usage: [usageOf("u")] } as never;

    expect(withHeldUndone(update, undefined)).toBe(update);
  });

  it("puts the held undo's spend and entries after the update's, a close replacing an open entry", () => {
    const open = entryOf("a", { sequence: 1 });
    const other = entryOf("b", { sequence: 2 });
    const closed = { ...open, status: CompensationEntryStatus.Closed };

    const merged = withHeldUndone(
      { usage: [usageOf("u1")], compensations: [open, other], next: "x" },
      { compensations: [closed], usage: [usageOf("u2")] },
    );

    expect(merged).toStrictEqual({
      usage: [usageOf("u1"), usageOf("u2")],
      compensations: [other, closed],
      next: "x",
    });
  });

  it("an update with no usage and no entries takes the held undo's own", () => {
    const closed = entryOf("a", { status: CompensationEntryStatus.Closed });

    expect(withHeldUndone({}, { compensations: [closed], usage: [usageOf("u")] })).toStrictEqual({
      usage: [usageOf("u")],
      compensations: [closed],
    });
  });

  it("writes no entries at all when there are none", () => {
    const merged = withHeldUndone({ next: "x" }, { compensations: [], usage: [] });

    expect(merged).toStrictEqual({ next: "x", usage: [] });
    expect("compensations" in merged).toBe(false);
  });

  it("takes an update's usage or entries that are no lists as none", () => {
    const closed = entryOf("a", { status: CompensationEntryStatus.Closed });

    expect(
      withHeldUndone({ usage: "x", compensations: 5 } as never, {
        compensations: [closed],
        usage: [usageOf("u")],
      }),
    ).toStrictEqual({ usage: [usageOf("u")], compensations: [closed] });
  });
});
