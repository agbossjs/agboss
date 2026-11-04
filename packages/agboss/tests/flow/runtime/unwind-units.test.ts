/**
 * #633 (unwind shard) — one automatic unwind (`unwind.ts`) on its own, each undo scripted: entries
 * merged so an open one never reopens a closed one, the running bodies awaited up to the bound and
 * each one still running reported, every open entry it covers undone newest first — mirrored,
 * marked, its failure listed —, and a sealing unwind's late undo run at once, its spend recorded,
 * its failure reported; the seal lifted once the bodies returned and one bound more passed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CompensationEntryStatus,
  CompensationStatus,
  type CompensationEntry,
} from "../../../src/flow/compensation.js";
import { CompensationRegistry } from "../../../src/flow/runtime/compensation/registry.js";
import {
  bodiesSettled,
  mergedEntries,
  unwound,
  type UnwindSite,
} from "../../../src/flow/runtime/compensation/unwind.js";
import { recordToolCost } from "../../../src/finops/usage.js";
import { VirtualClock } from "../../../src/testing/index.js";
import { seconds, type Milliseconds } from "../../../src/units/index.js";
import { closedOf, entryOf, TREE, undoOf } from "./fixtures/compensation-entries.js";

const mocks = vi.hoisted(() => ({ undone: vi.fn() }));

vi.mock("../../../src/flow/runtime/compensation/undo.js", () => ({ undone: mocks.undone }));

const USAGE = recordToolCost("release-room-action", 0.25);
const flushed = () => new Promise((resolve) => setImmediate(resolve));

/** A clock that keeps the signal of every sleep. */
class RecordingClock extends VirtualClock {
  readonly signals: (AbortSignal | undefined)[] = [];

  override sleep(delay: Milliseconds, signal?: AbortSignal): Promise<void> {
    this.signals.push(signal);
    return super.sleep(delay, signal);
  }
}

function siteOf(overrides: Partial<UnwindSite> = {}) {
  const warn = vi.fn();
  const record = vi.fn((_usage: readonly unknown[]) => Promise.resolve());
  const registry = new CompensationRegistry();
  const site: UnwindSite = {
    tree: TREE,
    covers: () => true,
    runs: () => true,
    known: [],
    undoSiteOf: () => ({}) as never,
    parts: { timeout: seconds(15), registry, log: { warn } as never },
    stepEntries: undefined,
    clock: new VirtualClock(),
    timeout: seconds(15),
    isSealing: false,
    record,
    ...overrides,
  };
  return { site, warn, record, registry };
}

beforeEach(() => {
  mocks.undone.mockReset();
  mocks.undone.mockImplementation((entry: CompensationEntry) =>
    Promise.resolve({ entry: closedOf(entry), record: undoOf(entry), usage: [USAGE] }),
  );
});

describe("#633: mergedEntries", () => {
  it("the later one wins — except that an open one never reopens a closed or committed one", () => {
    const committed = entryOf("b", { status: CompensationEntryStatus.Committed });
    const merged = mergedEntries(
      [entryOf("a"), closedOf(entryOf("b")), entryOf("c", { sequence: 1 })],
      [closedOf(entryOf("a")), entryOf("b"), entryOf("c", { sequence: 2 })],
      [committed],
    );

    expect(merged.map((entry) => [entry.key, entry.status, entry.sequence])).toEqual([
      ["a", CompensationEntryStatus.Closed, 1],
      ["b", CompensationEntryStatus.Committed, 1],
      ["c", CompensationEntryStatus.Open, 2],
    ]);
  });
});

describe("#633: the bodies an unwind awaits", () => {
  it("none tracked: nothing awaited", async () => {
    const { site } = siteOf();

    await expect(bodiesSettled(site)).resolves.toBeUndefined();
  });

  it("each body still running at the bound is reported with its execution and tenant; the bound's timer ended", async () => {
    const clock = new RecordingClock();
    const body = { executionId: "child-1", nodeId: "reserve-room-action" };
    const closedWhere = vi.fn(() => Promise.resolve([body]));
    const runs = () => true;
    const { site, warn } = siteOf({ clock, runs, stepEntries: { closedWhere } as never });

    await bodiesSettled(site);

    expect(closedWhere).toHaveBeenCalledWith(TREE, runs, expect.any(AbortSignal));
    expect(warn).toHaveBeenCalledWith(
      "compensation.step-still-running",
      "the undo of execution child-1 goes on while reserve-room-action still runs; it is undone when it returns",
      { executionId: "child-1", tenantId: "acme" },
    );
    expect(clock.signals.every((signal) => signal?.aborted === true)).toBe(true);
  });

  it("no parts: a body still running reported to no one", async () => {
    const closedWhere = () => Promise.resolve([{ executionId: "child-1", nodeId: "x" }]);
    const { site } = siteOf({ stepEntries: { closedWhere } as never, parts: undefined });

    await expect(bodiesSettled(site)).resolves.toBeUndefined();
  });

  it("no log: a body still running reported to no one", async () => {
    const closedWhere = () => Promise.resolve([{ executionId: "child-1", nodeId: "x" }]);
    const { site } = siteOf({
      stepEntries: { closedWhere } as never,
      parts: { timeout: seconds(15), registry: new CompensationRegistry() },
    });

    await expect(bodiesSettled(site)).resolves.toBeUndefined();
  });
});

describe("#633: the undos", () => {
  it("every open entry it covers, newest first: mirrored, marked, its spend kept, its failure listed", async () => {
    const onUndone = vi.fn((_entry: CompensationEntry) => Promise.resolve());
    const known = [
      entryOf("old", { sequence: 1 }),
      entryOf("new", { sequence: 2 }),
      entryOf("theirs", { sequence: 3, executionId: "other" }),
      closedOf(entryOf("done", { sequence: 4 })),
    ];
    mocks.undone.mockImplementation((entry: CompensationEntry) =>
      Promise.resolve({
        entry: closedOf(
          entry,
          entry.key === "old" ? CompensationStatus.Failed : CompensationStatus.Compensated,
        ),
        record: undoOf(
          entry,
          entry.key === "old" ? CompensationStatus.Failed : CompensationStatus.Compensated,
        ),
        usage: [USAGE],
      }),
    );
    const covers = (entry: CompensationEntry) => entry.executionId === "root-1";
    const { site, registry } = siteOf({ known, covers, onUndone });

    const done = await unwound(site);

    expect(done.closed.map((entry) => entry.key)).toEqual(["new", "old"]);
    expect(done.usage).toEqual([USAGE, USAGE]);
    expect(done.failures.map((failure) => failure.status)).toEqual([CompensationStatus.Failed]);
    expect(onUndone.mock.calls.map(([entry]) => entry.key)).toEqual(["new", "old"]);
    expect(registry.entriesOf(TREE, () => true).map((entry) => entry.status)).toEqual([
      CompensationEntryStatus.Closed,
      CompensationEntryStatus.Closed,
    ]);
  });

  it("no parts and no marks: still undone", async () => {
    const { site } = siteOf({ known: [entryOf("a")], parts: undefined, onUndone: undefined });

    expect((await unwound(site)).closed.map((entry) => entry.key)).toEqual(["a"]);
  });

  it("an entry the registry mirrors while it undoes is undone too", async () => {
    const { site, registry } = siteOf({ known: [entryOf("first", { sequence: 1 })] });
    mocks.undone.mockImplementationOnce((entry: CompensationEntry) => {
      registry.write(TREE, [entryOf("late", { sequence: 2 })]);
      return Promise.resolve({ entry: closedOf(entry), record: undoOf(entry), usage: [] });
    });

    expect((await unwound(site)).closed.map((entry) => entry.key)).toEqual(["first", "late"]);
  });
});

describe("#633: a sealing unwind", () => {
  /** A sealing site whose bodies return when told. */
  function sealing(overrides: Partial<UnwindSite> = {}) {
    let returned = (): void => undefined;
    const closedWhere = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockImplementation(
        () =>
          new Promise<readonly never[]>((resolve) => {
            returned = () => {
              resolve([]);
            };
          }),
      );
    const clock = new VirtualClock();
    const parts = siteOf({
      isSealing: true,
      clock,
      stepEntries: { closedWhere } as never,
      ...overrides,
    });
    return {
      ...parts,
      clock,
      returned: () => {
        returned();
      },
    };
  }

  it("a late entry undone at once, its spend recorded", async () => {
    const { site, registry, record } = sealing();
    await unwound(site);

    registry.write(TREE, [entryOf("late")]);
    await flushed();

    expect(mocks.undone).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledWith([USAGE]);
  });

  it("a late undo that failed or did not run: reported, there is no one to fail", async () => {
    const { site, registry, warn } = sealing();
    await unwound(site);
    mocks.undone
      .mockResolvedValueOnce({
        entry: closedOf(entryOf("a"), CompensationStatus.Failed),
        record: { ...undoOf(entryOf("a")), error: { message: "desk down" } },
        usage: [],
      })
      .mockRejectedValueOnce(new Error("no frame"));

    registry.write(TREE, [entryOf("a", { action: "reserve-room-action" })]);
    registry.write(TREE, [entryOf("b")]);
    await flushed();

    // each late undo runs on its own: in no set order
    expect([...warn.mock.calls].sort((a, b) => String(a[1]).localeCompare(String(b[1])))).toEqual([
      [
        "compensation.late-undo-failed",
        "the late undo of reserve-room-action by release-room-action failed: desk down",
        { executionId: "root-1", tenantId: "acme" },
      ],
      [
        "compensation.late-undo-failed",
        "the late undo of reserve-room-action did not run: no frame",
        { executionId: "root-1", tenantId: "acme" },
      ],
    ]);
  });

  it("a late undo that succeeded: nothing reported", async () => {
    const { site, registry, warn } = sealing();
    await unwound(site);

    registry.write(TREE, [entryOf("late")]);
    await flushed();

    expect(mocks.undone).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
  });

  it("a late undo that failed with no log: reported to no one", async () => {
    const parts = { timeout: seconds(15), registry: new CompensationRegistry() };
    const { site } = sealing({ parts });
    await unwound(site);
    mocks.undone.mockRejectedValueOnce(new Error("no frame"));

    parts.registry.write(TREE, [entryOf("late")]);
    await flushed();

    expect(mocks.undone).toHaveBeenCalledOnce();
  });

  it("lifted once the bodies returned and one bound more passed — not before", async () => {
    const { site, registry, clock, returned } = sealing();
    await unwound(site);

    returned();
    await flushed();
    await clock.advance(seconds(14));
    registry.write(TREE, [entryOf("still-sealed")]);
    await clock.advance(seconds(1));
    await flushed();
    registry.write(TREE, [entryOf("after")]);

    expect(mocks.undone.mock.calls.map(([entry]) => (entry as CompensationEntry).key)).toEqual([
      "still-sealed",
    ]);
    expect(registry.entriesOf(TREE, () => true).map((entry) => entry.key)).toEqual(["after"]);
  });

  it.each([
    ["not a sealing unwind", { isSealing: false }],
    ["no parts", { parts: undefined }],
    ["no step entries", { stepEntries: undefined }],
  ])("%s: no seal", async (_case, overrides) => {
    const { site, registry } = sealing(overrides);
    await unwound(site);

    registry.write(TREE, [entryOf("late")]);
    await flushed();

    expect(mocks.undone).not.toHaveBeenCalled();
  });
});
