/** #1281 (10), #1356 (WP6, unwind shard): what a step's failure hands the unwind of the entries its children held. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExecutionError } from "../../../src/core/error-families/run-errors.js";
import {
  COMPENSATION_TIMEOUT,
  CompensationEntryStatus,
  CompensationReason,
} from "../../../src/flow/compensation.js";
import { undoneHeldEntries } from "../../../src/flow/runtime/compensation/step-error-undo.js";
import { unwound, type UnwindSite } from "../../../src/flow/runtime/compensation/unwind.js";
import {
  markUndone,
  withUndoneMarks,
} from "../../../src/flow/runtime/compensation/unwinding-marks.js";
import { entryOf } from "./fixtures/compensation-entries.js";

vi.mock("../../../src/flow/runtime/compensation/unwind.js", () => ({ unwound: vi.fn() }));
vi.mock("../../../src/flow/runtime/compensation/unwinding-marks.js", () => ({
  withUndoneMarks: vi.fn(),
  markUndone: vi.fn(),
}));

const held = entryOf("held", { executionId: "child-1", heldBy: "root-1", childPath: ["trip"] });
const own = entryOf("own");
const foreign = entryOf("foreign", { executionId: "c", heldBy: "other", childPath: ["trip"] });
const done = entryOf("done", {
  executionId: "child-1",
  heldBy: "root-1",
  childPath: ["trip"],
  status: CompensationEntryStatus.Closed,
});

const unwoundSite = (): UnwindSite => {
  const [call] = vi.mocked(unwound).mock.calls;
  if (call === undefined) throw new Error("nothing was unwound");
  return call[0];
};

const record = vi.fn((_usage: unknown) => Promise.resolve());
const trees = { tag: "trees" };

const siteOf = (compensation: unknown = { trees, timeout: 77 }) =>
  ({
    state: { compensations: [own, held, foreign, done] },
    frame: {
      execution: { executionId: "root-1", tenant: { tenantId: "acme" } },
    },
    deps: {
      graph: { tag: "graph" },
      container: { tag: "container" },
      components: { tag: "components" },
      observer: { tag: "observer" },
      stepEntries: { tag: "stepEntries" },
      limits: { budgets: { record } },
      compensation,
    },
    clock: { tag: "clock" },
    cause: new Error("the step failed"),
  }) as never;

beforeEach(() => {
  record.mockClear();
  vi.mocked(unwound).mockReset();
  vi.mocked(markUndone).mockReset();
  vi.mocked(withUndoneMarks)
    .mockReset()
    // the marks of the tree close what an earlier pass of the visit undid
    .mockImplementation((_marks, entries) => Promise.resolve([...entries, done]));
});

describe("undoneHeldEntries: what the unwind is given", () => {
  it("the marks of the tree, the held entries only, the undo's own settings", async () => {
    const closed = entryOf("closed", { status: CompensationEntryStatus.Closed });
    vi.mocked(unwound).mockResolvedValue({ closed: [closed], usage: [], failures: [] });

    await undoneHeldEntries(siteOf());

    const marks = { trees, tree: { tenantId: "acme", rootExecutionId: "root-1" } };
    expect(withUndoneMarks).toHaveBeenCalledExactlyOnceWith(marks, [held]);
    const call = vi.mocked(unwound).mock.calls[0]?.[0];
    expect(call).toMatchObject({
      tree: marks.tree,
      known: [held, done],
      timeout: 77,
      isSealing: false,
      clock: { tag: "clock" },
      stepEntries: { tag: "stepEntries" },
      parts: { trees, timeout: 77 },
    });
    expect(call?.runs(held as never)).toBe(false);
    expect(call?.covers(held)).toBe(true);
    expect(call?.covers(own)).toBe(false);
    expect(call?.covers(foreign)).toBe(false);
    expect(call?.covers(done)).toBe(false);
  });

  it("each entry undoes in the workflow of the execution that opened it, as a step's failure", async () => {
    vi.mocked(unwound).mockResolvedValue({ closed: [], usage: [], failures: [] });
    const site = siteOf();

    await undoneHeldEntries(site);

    const { undoSiteOf } = unwoundSite();
    expect(undoSiteOf(own)).toStrictEqual({
      graph: { tag: "graph" },
      container: { tag: "container" },
      components: { tag: "components" },
      observer: { tag: "observer" },
      execution: (site as { frame: { execution: unknown } }).frame.execution,
      clock: { tag: "clock" },
      timeout: 77,
      stepEntries: { tag: "stepEntries" },
      reason: CompensationReason.StepFailed,
    });
  });

  it("an undo's spend is recorded in the budgets, each success is marked in the tree", async () => {
    vi.mocked(unwound).mockResolvedValue({ closed: [], usage: [], failures: [] });

    await undoneHeldEntries(siteOf());

    const call = unwoundSite();
    await call.record([{ id: "u" } as never]);
    await call.onUndone?.(held);
    expect(record).toHaveBeenCalledExactlyOnceWith([{ id: "u" }]);
    expect(markUndone).toHaveBeenCalledExactlyOnceWith(
      { trees, tree: { tenantId: "acme", rootExecutionId: "root-1" } },
      held,
    );
  });

  it("with no compensation parts: the default timeout, and no store for the marks", async () => {
    vi.mocked(unwound).mockResolvedValue({ closed: [], usage: [], failures: [] });

    await undoneHeldEntries(siteOf(null));

    expect(withUndoneMarks).toHaveBeenCalledWith(
      { trees: undefined, tree: { tenantId: "acme", rootExecutionId: "root-1" } },
      expect.anything(),
    );
    expect(unwoundSite().timeout).toBe(COMPENSATION_TIMEOUT);
  });

  it("parts without a timeout of their own: the default timeout", async () => {
    vi.mocked(unwound).mockResolvedValue({ closed: [], usage: [], failures: [] });

    await undoneHeldEntries(siteOf({ trees }));

    expect(unwoundSite().timeout).toBe(COMPENSATION_TIMEOUT);
  });
});

describe("undoneHeldEntries: what it gives back", () => {
  it("the entries an earlier pass closed, then the ones this pass closed, and the spend", async () => {
    const closed = entryOf("closed", { status: CompensationEntryStatus.Closed });
    vi.mocked(unwound).mockResolvedValue({
      closed: [closed],
      usage: [{ id: "u" } as never],
      failures: [],
    });

    const result = await undoneHeldEntries(siteOf());

    expect(result).toStrictEqual({ compensations: [done, closed], usage: [{ id: "u" }] });
    expect(record).not.toHaveBeenCalled();
  });

  it("an undo that failed: its spend recorded, then ExecutionError.CompensationFailed that carries the failures and the step's failure", async () => {
    const failure = {
      status: "failed",
      compensator: { name: "release-room-action" },
      compensated: { component: { name: "reserve-room-action" } },
      error: { message: "desk down" },
    } as never;
    vi.mocked(unwound).mockResolvedValue({
      closed: [],
      usage: [{ id: "u" } as never],
      failures: [failure],
    });
    const site = siteOf();

    const error = await undoneHeldEntries(site).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ExecutionError.CompensationFailed);
    const failed = error as InstanceType<typeof ExecutionError.CompensationFailed>;
    expect(failed.failures).toStrictEqual([failure]);
    expect(failed.cause).toBe((site as { cause: unknown }).cause);
    expect(record).toHaveBeenCalledExactlyOnceWith([{ id: "u" }]);
  });
});
