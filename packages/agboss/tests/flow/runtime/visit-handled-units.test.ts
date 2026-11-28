/** #1281 (10), #675, #1356 (WP6, unwind shard): what a handled failure's visit adds to its update. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handledFailure, stoppedAtDispatch } from "../../../src/flow/runtime/visit-handled.js";
import { compensationsOfHeldVisit, compensationsOfVisit } from "../../../src/flow/compensation.js";
import { heldEntriesUndone } from "../../../src/flow/runtime/compensation/held-on-error.js";
import { entryOf } from "./fixtures/compensation-entries.js";

vi.mock("../../../src/flow/compensation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/flow/compensation.js")>()),
  compensationsOfVisit: vi.fn(),
  compensationsOfHeldVisit: vi.fn(),
}));
vi.mock("../../../src/flow/runtime/compensation/held-on-error.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../src/flow/runtime/compensation/held-on-error.js")
  >()),
  heldEntriesUndone: vi.fn(),
}));

const u = (id: string) => ({ id }) as never;
const own = entryOf("own", { sequence: 3 });
const reported = entryOf("reported", { sequence: 2 });
const held = entryOf("held", { sequence: 1 });

const siteOf = (over: Record<string, unknown> = {}) =>
  ({
    state: { compensations: [] },
    deps: { tag: "deps" },
    clock: { tag: "clock" },
    frame: { tag: "frame" },
    isHeldBack: false,
    reported: { compensations: [reported] },
    failure: new Error("failed"),
    ...over,
  }) as never;

beforeEach(() => {
  vi.mocked(compensationsOfVisit).mockReset();
  vi.mocked(compensationsOfHeldVisit).mockReset();
  vi.mocked(heldEntriesUndone).mockReset();
});

describe("handledFailure", () => {
  it("the failed child's undone entries first, the visit's own after, spend in the same order", async () => {
    vi.mocked(compensationsOfVisit).mockResolvedValue({
      compensations: [own],
      usage: [u("own")],
    } as never);
    vi.mocked(heldEntriesUndone).mockResolvedValue({ compensations: [held], usage: [u("held")] });
    const site = siteOf();

    const update = await handledFailure({ usage: [u("handled")], next: "side" }, site);

    expect(update).toStrictEqual({
      next: "side",
      usage: [u("handled"), u("held"), u("own")],
      compensations: [held, reported, own],
    });
    expect(compensationsOfVisit).toHaveBeenCalledExactlyOnceWith(site);
    expect(compensationsOfHeldVisit).not.toHaveBeenCalled();
    expect(heldEntriesUndone).toHaveBeenCalledExactlyOnceWith({
      state: { compensations: [] },
      frame: { tag: "frame" },
      deps: { tag: "deps" },
      clock: { tag: "clock" },
      cause: (site as { failure: unknown }).failure,
    });
  });

  it("with nothing held and nothing of its own: the update's usage and no entries at all", async () => {
    vi.mocked(compensationsOfVisit).mockResolvedValue({});
    vi.mocked(heldEntriesUndone).mockResolvedValue(undefined);

    const update = await handledFailure(
      { next: "side" },
      siteOf({ reported: { compensations: [] } }),
    );

    expect(update).toStrictEqual({ next: "side", usage: [] });
    expect("compensations" in update).toBe(false);
  });

  it("an update whose usage is no list has none of its own", async () => {
    vi.mocked(compensationsOfVisit).mockResolvedValue({ usage: [u("own")] } as never);
    vi.mocked(heldEntriesUndone).mockResolvedValue(undefined);

    const update = await handledFailure({ usage: "x" } as never, siteOf());

    expect(update.usage).toStrictEqual([u("own")]);
  });

  it("a held-back undo action's owed undo is run, with the clock and the deps, instead of the close", async () => {
    vi.mocked(compensationsOfHeldVisit).mockResolvedValue({ compensations: [own], usage: [] });
    vi.mocked(heldEntriesUndone).mockResolvedValue(undefined);
    const site = siteOf({ isHeldBack: true });

    const update = await handledFailure({}, site);

    expect(compensationsOfVisit).not.toHaveBeenCalled();
    expect(compensationsOfHeldVisit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ clock: { tag: "clock" }, deps: { tag: "deps" } }),
    );
    expect(update.compensations).toStrictEqual([reported, own]);
  });
});

describe("stoppedAtDispatch", () => {
  const closed = entryOf("taken", { status: "closed" as never });

  it("undoes what the children held with the step's own just-taken entries among them", async () => {
    vi.mocked(heldEntriesUndone).mockResolvedValue({ compensations: [closed], usage: [u("h")] });
    const taken = entryOf("taken", { sequence: 5 });
    const before = entryOf("before", { sequence: 4 });
    const site = { state: { compensations: [before] }, tag: "site" } as never;

    const update = await stoppedAtDispatch({ compensations: [taken], usage: [u("v")] }, site);

    expect(vi.mocked(heldEntriesUndone).mock.calls[0]?.[0]).toMatchObject({
      tag: "site",
      state: { compensations: [before, taken] },
    });
    expect(update).toStrictEqual({ usage: [u("v"), u("h")], compensations: [closed] });
  });

  it("an update that opened no entries leaves the state's as they are", async () => {
    vi.mocked(heldEntriesUndone).mockResolvedValue(undefined);
    const before = entryOf("before");
    const site = { state: { compensations: [before] } } as never;

    const visited = { next: "x" } as never;
    const update = await stoppedAtDispatch(visited, site);

    expect(vi.mocked(heldEntriesUndone).mock.calls[0]?.[0]).toMatchObject({
      state: { compensations: [before] },
    });
    expect(update).toBe(visited);
  });
});
