/**
 * #633 (undo shard) — the undo a held-back visit owes (#675, `held-undo.ts`) on its own, its unwind
 * scripted: the newest open entry its undo action undoes — never a closed one, never another
 * action's —, undone as an undo of its own (its key only, no body awaited, no seal, the
 * application's bound), its spend to the budgets, and one an earlier pass undid closed by its mark.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  COMPENSATION_TIMEOUT,
  CompensationEntryStatus,
  CompensationReason,
  type HeldVisitSite,
} from "../../../src/flow/compensation.js";
import { heldUndoOf } from "../../../src/flow/runtime/compensation/held-undo.js";
import type { UnwindSite } from "../../../src/flow/runtime/compensation/unwind.js";
import { markUndone } from "../../../src/flow/runtime/compensation/unwinding-marks.js";
import { recordToolCost } from "../../../src/finops/usage.js";
import { InMemoryDatabase } from "../../../src/infrastructure/in-memory-database.js";
import { InMemoryExecutionTreeRepository } from "../../../src/infrastructure/execution-tree.repository.js";
import { seconds } from "../../../src/units/index.js";
import { closedOf, entryOf, TREE } from "./fixtures/compensation-entries.js";

const mocks = vi.hoisted(() => ({ unwound: vi.fn() }));

vi.mock("../../../src/flow/runtime/compensation/unwind.js", () => ({ unwound: mocks.unwound }));

const USAGE = recordToolCost("release-room-action", 0.5);

function siteOf(entries: HeldVisitSite["entries"], parts?: HeldVisitSite["parts"]) {
  const record = vi.fn(() => Promise.resolve());
  const site: HeldVisitSite = {
    node: { id: "release-room-action" },
    entries,
    frame: { execution: { tenant: { tenantId: "acme" }, executionId: "root-1" } },
    parts,
    clock: {},
    deps: { graph: {}, container: {}, components: new Map(), limits: { budgets: { record } } },
  } as never;
  return { site, record };
}

/** The unwind the held undo asked for. */
const unwindAsked = (): UnwindSite => mocks.unwound.mock.calls[0]?.[0] as UnwindSite;

beforeEach(() => {
  mocks.unwound.mockReset();
  mocks.unwound.mockImplementation((site: UnwindSite) =>
    Promise.resolve({
      closed: site.known
        .filter((entry) => entry.status === CompensationEntryStatus.Open)
        .map((entry) => closedOf(entry)),
      usage: [USAGE],
      failures: [],
    }),
  );
});

describe("#633: the entry a held-back visit owes", () => {
  it("none open of its undo action: nothing undone", async () => {
    const { site } = siteOf([
      closedOf(entryOf("closed")),
      entryOf("other", { compensator: "release-seat-action" }),
    ]);

    expect(await heldUndoOf(site)).toEqual({});
    expect(mocks.unwound).not.toHaveBeenCalled();
  });

  it("the newest open one of its undo action, by its place in the tree's order", async () => {
    const { site } = siteOf([
      entryOf("newest", { sequence: 3 }),
      entryOf("oldest", { sequence: 1 }),
      entryOf("middle", { sequence: 2 }),
      entryOf("seat", { sequence: 4, compensator: "release-seat-action" }),
      closedOf(entryOf("closed", { sequence: 5 })),
    ]);

    await heldUndoOf(site);

    const unwind = unwindAsked();
    expect(unwind.known.map((entry) => entry.key)).toEqual(["newest"]);
    expect([unwind.covers(entryOf("newest")), unwind.covers(entryOf("middle"))]).toEqual([
      true,
      false,
    ]);
  });
});

describe("#633: undone as an undo of its own", () => {
  it("no body awaited, no seal, the default bound, its spend to the budgets, its entry closed", async () => {
    const { site, record } = siteOf([entryOf("room")]);

    const held = await heldUndoOf(site);
    const unwind = unwindAsked();
    await unwind.record([USAGE]);

    expect(unwind.runs({} as never)).toBe(false);
    expect({ isSealing: unwind.isSealing, timeout: unwind.timeout }).toEqual({
      isSealing: false,
      timeout: COMPENSATION_TIMEOUT,
    });
    expect(unwind.tree).toEqual({ tenantId: "acme", rootExecutionId: "root-1" });
    expect(unwind.undoSiteOf(entryOf("room")).reason).toBe(CompensationReason.SidePath);
    expect(record).toHaveBeenCalledWith([USAGE]);
    expect(held).toEqual({ compensations: [closedOf(entryOf("room"))], usage: [USAGE] });
  });

  it("the application's bound and its tree keys: an earlier pass's undo closed by its mark", async () => {
    const trees = new InMemoryExecutionTreeRepository(new InMemoryDatabase());
    await markUndone({ trees, tree: TREE }, closedOf(entryOf("room")));
    const parts = { timeout: seconds(3), registry: {} as never, trees };
    const { site } = siteOf([entryOf("room")], parts);

    const held = await heldUndoOf(site);

    expect(unwindAsked().timeout).toBe(seconds(3));
    expect(held.compensations?.map((entry) => entry.status)).toEqual([
      CompensationEntryStatus.Closed,
    ]);
    expect(held.usage).toEqual([USAGE]);
  });
});
