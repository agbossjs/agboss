/**
 * #1366: a failed launch with an `.onError` side path starts it with the answers already settled — the
 * finished branches' values, one write per group that has a shape, none for the branches whose undo ran in
 * this join (by the launch's own compensations only) — and with the config only when there is one; the
 * failing branch's node is the launcher when the record is of no ticketed branch; a branch with no error
 * record fails with a generic error; an expired branch off the ticket still fails a plain join.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  compensationsOfFailedJoin: vi.fn(),
  joinedValues: vi.fn(),
  errorHandlerOf: vi.fn(),
  handledErrorOf: vi.fn(),
}));
vi.mock("../../../src/flow/compensation.js", async (original) => ({
  ...(await original<typeof import("../../../src/flow/compensation.js")>()),
  compensationsOfFailedJoin: mocks.compensationsOfFailedJoin,
}));
vi.mock("../../../src/flow/runtime/launch/join-notices.js", () => ({
  noticeJoinFailed: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../../src/flow/runtime/launch/withdrawn-pauses.js", () => ({
  launchPausesOf: vi.fn(() => ({})),
}));
vi.mock("../../../src/flow/runtime/launch/join-write.js", () => ({
  joinedValues: mocks.joinedValues,
}));
vi.mock("../../../src/flow/runtime/graph-model.js", async (original) => ({
  ...(await original<typeof import("../../../src/flow/runtime/graph-model.js")>()),
  errorHandlerOf: mocks.errorHandlerOf,
}));
vi.mock("../../../src/flow/runtime/workflow-keys.js", async (original) => ({
  ...(await original<typeof import("../../../src/flow/runtime/workflow-keys.js")>()),
  handledErrorOf: mocks.handledErrorOf,
}));

const { failedJoined, failureRecordOf, failingRecordOf } =
  await import("../../../src/flow/runtime/launch/join-failure.js");
const { BranchStatus } = await import("../../../src/flow/runtime/launch/records.js");
const { FailurePolicy } = await import("../../../src/flow/decorators/router.js");

const failure = { name: "Error", code: "Error", lineage: [], message: "boom" };
const failedRecord = {
  launchId: "l1",
  index: 0,
  status: BranchStatus.Failed,
  read: [],
  error: failure,
};
const finished = (index: number) => ({
  launchId: "l1",
  index,
  status: BranchStatus.Finished,
  read: [],
});
const shape = { name: "S" };

function site(over: { config?: object; branches?: object[]; records?: object[] } = {}) {
  const parts = {
    state: { compensations: [] },
    config: over.config,
    ticket: {
      launchId: "l1",
      launcher: "launcher",
      branches: over.branches ?? [
        { node: "branch-a", nodeId: "a" },
        { node: "branch-b", nodeId: "b" },
      ],
    },
    deps: { pauses: {}, limits: { budgets: { record: vi.fn(() => Promise.resolve()) } } },
    records: over.records ?? [failedRecord, finished(1), finished(2)],
  };
  return parts;
}
const compensation = (launchId: string, nodeId: string) => ({ launchId, compensated: { nodeId } });
const launch = { launch: "the-launch", joinErrors: [] };
const joinedCall = () => mocks.joinedValues.mock.calls[0] as unknown[];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.compensationsOfFailedJoin.mockResolvedValue({ compensations: [] });
  mocks.joinedValues.mockResolvedValue({ next: "side" });
  mocks.handledErrorOf.mockReturnValue({ handled: true });
});

describe("#1366: the answers a side path starts with", () => {
  it("one value write per group with a shape (none for a group without), the launch's groups", async () => {
    const groups = [
      { slot: "s1", producers: ["a"], isSeveral: false, shape },
      { slot: "s2", producers: ["b"], isSeveral: false, problem: "none" },
    ];
    mocks.errorHandlerOf.mockReturnValue({ to: "side", settled: groups });

    await failedJoined(
      launch as never,
      { record: failedRecord, thrown: new Error("x") },
      site() as never,
    );

    const edge = joinedCall()[1] as { join: unknown; to: string };
    expect(edge.to).toBe("side");
    expect(edge.join).toStrictEqual({
      launch: "the-launch",
      values: [{ shape, isCase: false }],
      groups,
    });
  });

  it("a handler without settled groups: no groups and no values", async () => {
    mocks.errorHandlerOf.mockReturnValue({ to: "side" });

    await failedJoined(
      launch as never,
      { record: failedRecord, thrown: new Error("x") },
      site() as never,
    );

    const edge = joinedCall()[1] as { join: unknown };
    expect(edge.join).toStrictEqual({ launch: "the-launch", values: [], groups: [] });
  });

  it("the finished branches are given; those undone by THIS launch's compensations are left out", async () => {
    mocks.errorHandlerOf.mockReturnValue({ to: "side" });
    mocks.compensationsOfFailedJoin.mockResolvedValue({
      compensations: [compensation("l1", "a"), compensation("other-launch", "b")],
    });
    const parts = site({
      branches: [
        { node: "branch-a", nodeId: "a" },
        { node: "branch-b", nodeId: "b" },
        { node: "branch-c", nodeId: "c" },
      ],
      records: [failedRecord, finished(0), finished(1), finished(2)],
    });

    await failedJoined(
      launch as never,
      { record: failedRecord, thrown: new Error("x") },
      parts as never,
    );

    const given = joinedCall()[3] as { index: number }[];
    expect(given.map((record) => record.index)).toStrictEqual([1, 2]);
  });

  it("a finished record the ticket has no branch for is still given", async () => {
    mocks.errorHandlerOf.mockReturnValue({ to: "side" });
    mocks.compensationsOfFailedJoin.mockResolvedValue({ compensations: [compensation("l1", "a")] });
    const parts = site({ records: [failedRecord, finished(7)] });

    await failedJoined(
      launch as never,
      { record: failedRecord, thrown: new Error("x") },
      parts as never,
    );

    const given = joinedCall()[3] as { index: number }[];
    expect(given.map((record) => record.index)).toStrictEqual([7]);
  });

  it("nothing undone and compensations of other launches only: every finished branch is given", async () => {
    // a branch whose node id is an odd string is still given: only real undos remove a branch
    mocks.errorHandlerOf.mockReturnValue({ to: "side" });
    const parts = site({
      branches: [{ node: "n", nodeId: "Stryker was here" }],
      records: [failedRecord, finished(0)],
    });

    mocks.compensationsOfFailedJoin.mockResolvedValue({});
    await failedJoined(
      launch as never,
      { record: failedRecord, thrown: new Error("x") },
      parts as never,
    );
    expect((joinedCall()[3] as unknown[]).length).toBe(1);

    mocks.joinedValues.mockClear();
    mocks.compensationsOfFailedJoin.mockResolvedValue({
      compensations: [compensation("other-launch", "x")],
    });
    await failedJoined(
      launch as never,
      { record: failedRecord, thrown: new Error("x") },
      parts as never,
    );
    expect((joinedCall()[3] as unknown[]).length).toBe(1);
  });

  it("the config reaches the join's context only when there is one", async () => {
    mocks.errorHandlerOf.mockReturnValue({ to: "side" });
    const config = { configurable: {} };

    await failedJoined(
      launch as never,
      { record: failedRecord, thrown: new Error("x") },
      site({ config }) as never,
    );
    expect(Object.keys(joinedCall()[4] as object).sort()).toStrictEqual([
      "config",
      "deps",
      "state",
    ]);

    mocks.joinedValues.mockClear();
    await failedJoined(
      launch as never,
      { record: failedRecord, thrown: new Error("x") },
      site() as never,
    );
    expect(Object.keys(joinedCall()[4] as object).sort()).toStrictEqual(["deps", "state"]);
  });

  it("the failing branch's node is the one of its ticket; the launcher when the ticket has none for it", async () => {
    mocks.errorHandlerOf.mockReturnValue({ to: "side" });

    await failedJoined(
      launch as never,
      { record: failedRecord, thrown: new Error("x") },
      site() as never,
    );
    expect(mocks.handledErrorOf.mock.calls[0]?.[2]).toBe("branch-a");

    mocks.handledErrorOf.mockClear();
    const off = { ...failedRecord, index: 9 };
    await failedJoined(launch as never, { record: off, thrown: new Error("x") }, site() as never);
    expect(mocks.handledErrorOf.mock.calls[0]?.[2]).toBe("launcher");
  });
});

describe("#1366: the failing records", () => {
  it("a branch with no error record fails with a generic one", () => {
    expect(
      failureRecordOf({ launchId: "l", index: 0, status: BranchStatus.Failed, read: [] }),
    ).toStrictEqual({
      name: "Error",
      code: "Error",
      lineage: [],
      message: "failed",
    });
    expect(failureRecordOf(failedRecord)).toBe(failure);
  });

  it("an expired branch the ticket has no entry for fails a plain join; a skipped-by-policy one does not", () => {
    const expired = (index: number) => ({
      launchId: "l1",
      index,
      status: BranchStatus.Expired,
      read: [],
    });
    const ticket = { branches: [{ node: "a", nodeId: "a", failure: FailurePolicy.Skip }] };
    expect(failingRecordOf({} as never, ticket as never, [expired(5)] as never)).toStrictEqual(
      expired(5),
    );
    expect(failingRecordOf({} as never, ticket as never, [expired(0)] as never)).toBeUndefined();
  });
});
