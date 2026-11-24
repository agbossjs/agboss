/**
 * #1366: a launch that fails with no `.onError` side path to take it throws the branch's error, and the
 * spend of the undo it ran first (#340) reaches no state: it is written to the ledger at once, so no paid
 * compensation is ever lost. With a side path the spend travels in the state and is not written twice.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CostSource, ZERO_USAGE, type UsageRecord } from "../../../src/finops/usage.js";

const { compensationsOfFailedJoin } = vi.hoisted(() => ({ compensationsOfFailedJoin: vi.fn() }));
vi.mock("../../../src/flow/compensation.js", async (original) => ({
  ...(await original<typeof import("../../../src/flow/compensation.js")>()),
  compensationsOfFailedJoin,
}));
vi.mock("../../../src/flow/runtime/launch/join-notices.js", () => ({
  noticeJoinFailed: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../../src/flow/runtime/launch/withdrawn-pauses.js", () => ({
  launchPausesOf: vi.fn(() => ({})),
}));

const { failedJoined } = await import("../../../src/flow/runtime/launch/join-failure.js");
const { BranchStatus } = await import("../../../src/flow/runtime/launch/records.js");

const undoSpend: UsageRecord = {
  ...ZERO_USAGE,
  caller: "refund-action",
  model: "m",
  costUsd: 0.75,
  costSource: CostSource.Api,
};

function site() {
  const record = vi.fn(() => Promise.resolve());
  const failedRecord = {
    launchId: "l1",
    index: 0,
    status: BranchStatus.Failed,
    error: { name: "Error", code: "Error", lineage: [], message: "boom" },
  };
  const parts = {
    state: {},
    config: undefined,
    ticket: { launchId: "l1", launcher: "launcher", branches: [{ node: "branch", nodeId: "b" }] },
    deps: { pauses: {}, limits: { budgets: { record } } },
    records: [failedRecord],
  };
  return { record, failedRecord, parts };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("#1366: the spend of an undo run by a failed join", () => {
  it("no side path: the branch's error is thrown and the undo's usage is recorded in the ledger", async () => {
    const { record, failedRecord, parts } = site();
    const thrown = new Error("boom");
    compensationsOfFailedJoin.mockResolvedValue({ usage: [undoSpend], compensations: [] });
    const launch = { joinErrors: [] };

    await expect(
      failedJoined(launch as never, { record: failedRecord, thrown } as never, parts as never),
    ).rejects.toBe(thrown);

    expect(record).toHaveBeenCalledExactlyOnceWith([undoSpend]);
  });

  it("no side path and nothing undone: the ledger is told of no spend", async () => {
    const { record, failedRecord, parts } = site();
    const thrown = new Error("boom");
    compensationsOfFailedJoin.mockResolvedValue({});

    await expect(
      failedJoined(
        { joinErrors: [] } as never,
        { record: failedRecord, thrown } as never,
        parts as never,
      ),
    ).rejects.toBe(thrown);

    expect(record).toHaveBeenCalledExactlyOnceWith([]);
  });
});
