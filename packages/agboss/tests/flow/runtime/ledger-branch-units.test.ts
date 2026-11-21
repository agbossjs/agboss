/**
 * #1366 (ledger-branch shard) — the spend of one branch of a launch, each rule on its own over fakes: what a
 * branch that answered writes (its node's usage, its arbiters' decisions counted as they end, its services),
 * what a failed branch carries (the spend its error holds, its services) and what a branch cancelled before it
 * ran keeps — all of it also on the launch's list, which the siblings that start later read.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CostSource, ZERO_USAGE, type UsageRecord } from "../../../src/finops/usage.js";
import { PaidStepError } from "../../../src/graph/errors.js";
import { FailurePolicy } from "../../../src/flow/decorators/router.js";
import { branchNode } from "../../../src/flow/runtime/launch/branch-runner.js";
import { BranchStatus } from "../../../src/flow/runtime/launch/records.js";
import { abortLaunch, settledEnd } from "../../../src/flow/runtime/launch/branch-settle.js";
import {
  executionSignalOf,
  failedStatusOf,
  passThroughStops,
} from "../../../src/flow/runtime/launch/branch-end.js";
import { arbiterDepsFor, liveLaunchOf } from "../../../src/flow/runtime/launch/branch-quorum.js";
import { leaveQuorum, markAnswer } from "../../../src/flow/runtime/launch/quorum-branch.js";
import { recordBranchLostPasses } from "../../../src/flow/runtime/lost-pass-records.js";
import { checkVisit } from "../../../src/flow/runtime/limits.js";
import { failedVisitOf, visitStepsOf } from "../../../src/flow/runtime/visit-step.js";
import { reportBranch } from "../../../src/flow/runtime/launch/launch-report.js";
import { withQuorumDeadline } from "../../../src/flow/runtime/launch/branch-view.js";
import { compensationsOfBranch } from "../../../src/flow/compensation.js";

vi.mock("../../../src/flow/runtime/launch/branch-view.js", () => ({
  branchLaunchOf: vi.fn(() => ({
    launch: { joinNodeId: "join" },
    ticket: { launchId: "L1", deadlineAt: 1000 },
  })),
  branchTicketOf: vi.fn(() => ({ index: 2, nodeId: "n", failure: "fail-fast" })),
  scheduledOf: vi.fn(() => "scheduled"),
  branchStateOf: vi.fn(
    (state: { usage: unknown[] }, _launch: unknown, _ticket: unknown, spent: unknown[]) => ({
      ...state,
      usage: [...state.usage, ...spent],
    }),
  ),
  withQuorumDeadline: vi.fn((state: unknown) => state),
  branchFrameOf: vi.fn(() => ({
    config: "config",
    frame: { step: { component: "component" } },
    signal: "signal",
    budgetStop: "stop",
  })),
  branchVisitOf: vi.fn(() => ({ visited: true })),
}));
vi.mock("../../../src/flow/runtime/launch/branch-quorum.js", () => ({
  arbiterDepsFor: vi.fn(() => "arbiter-deps"),
  liveLaunchOf: vi.fn(),
}));
vi.mock("../../../src/flow/runtime/launch/quorum-branch.js", () => ({
  leaveQuorum: vi.fn(),
  markAnswer: vi.fn(),
}));
vi.mock("../../../src/flow/runtime/launch/branch-end.js", async (original) => ({
  ...(await original<typeof import("../../../src/flow/runtime/launch/branch-end.js")>()),
  executionSignalOf: vi.fn(() => new AbortController().signal),
  failedStatusOf: vi.fn(),
  failureOfBranch: vi.fn((_stop: unknown, error: unknown) => error),
  passThroughStops: vi.fn(),
}));
vi.mock("../../../src/flow/runtime/launch/branch-settle.js", () => ({
  abortLaunch: vi.fn(() => Promise.resolve()),
  settledEnd: vi.fn((_run: unknown, end: unknown) => Promise.resolve(end)),
}));
vi.mock("../../../src/flow/runtime/launch/branch-schedule.js", () => ({
  gated: vi.fn((_gate: unknown, work: () => unknown) => work()),
  inSchedule: vi.fn((_scheduler: unknown, _branch: unknown, work: () => unknown) => work()),
}));
vi.mock("../../../src/flow/runtime/launch/launch-report.js", () => ({
  reportBranch: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../../src/flow/runtime/visit-step.js", () => ({
  visitStepsOf: vi.fn(() => ["steps"]),
  visitTimerOf: vi.fn(() => () => "site"),
  failedVisitOf: vi.fn(() => ({ failedVisit: true })),
}));
vi.mock("../../../src/flow/compensation.js", async (original) => ({
  ...(await original<typeof import("../../../src/flow/compensation.js")>()),
  compensationsOfBranch: vi.fn(() => Promise.resolve({ compensations: "opened" })),
}));
vi.mock("../../../src/flow/runtime/limits.js", () => ({ checkVisit: vi.fn(() => true) }));
vi.mock("../../../src/flow/runtime/step-frame.js", () => ({
  inTreeSlot: vi.fn((_slot: unknown, work: () => unknown) => work()),
  startedVersionOf: vi.fn(() => "v1"),
}));
vi.mock("../../../src/flow/runtime/lost-pass-records.js", () => ({
  recordBranchLostPasses: vi.fn(),
}));
vi.mock("../../../src/flow/runtime/node-runner.js", async (original) => ({
  ...(await original<typeof import("../../../src/flow/runtime/node-runner.js")>()),
  recordsOf: vi.fn(() => ({ records: true })),
}));
vi.mock("../../../src/flow/context/frame.js", () => ({
  runInFrame: vi.fn((_frame: unknown, work: () => unknown) => work()),
}));

const record = (costUsd: number, caller = "agent:a"): UsageRecord => ({
  ...ZERO_USAGE,
  caller,
  model: "m",
  costUsd,
  costSource: CostSource.Api,
});

/** The launch as one process has it: what its branches spent, its errors, its controller and its slots. */
const liveOf = (changes: Record<string, unknown> = {}) => ({
  spent: [] as UsageRecord[],
  errors: new Map<number, unknown>(),
  controller: new AbortController(),
  slots: { acquire: vi.fn((_stop: AbortSignal) => Promise.resolve(true)), release: vi.fn() },
  quorum: undefined,
  ...changes,
});

const stateOf = () => ({ runId: "run-1", path: ["a"], usage: [record(1, "before")] });

/** A branch node over fakes; `limits.budgets.tally` counts what the arbiters spent. */
function setup(options: { live?: ReturnType<typeof liveOf>; runner?: () => unknown } = {}) {
  const live = options.live ?? liveOf();
  vi.mocked(liveLaunchOf).mockReturnValue(live as never);
  const tally = vi.fn((records: readonly UsageRecord[]) => records);
  const keep = vi.fn();
  const started = vi.fn();
  const deps = {
    graph: { launches: [] },
    limits: { budgets: { tally } },
    workflow: "workflow",
    scheduler: { started },
    branchErrors: { keep },
  };
  const runner = vi.fn((_view: { usage: UsageRecord[] }, _config: unknown) =>
    (options.runner ?? (() => Promise.resolve({ value: { x: 1 }, read: ["r"] })))(),
  );
  const node = branchNode({ id: "n" } as never, runner as never, deps as never);
  return { live, tally, keep, started, deps, runner, node };
}

/** What the arbiter deps were given of the branch: the services it can push spend to. */
const servicesOf = (): UsageRecord[] =>
  // the services are the branch's own list, which its node pushes to
  (vi.mocked(arbiterDepsFor).mock.calls[0]?.[0].services ?? []) as UsageRecord[];

/** The records a branch node adds for its branch. */
const addedOf = (out: object): Record<string, unknown>[] =>
  (out as { branchRecords: { add: Record<string, unknown>[] } }).branchRecords.add;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(markAnswer).mockResolvedValue({ usage: [] });
  vi.mocked(checkVisit).mockResolvedValue(true);
});

describe("#1366: a branch that answered writes the spend of its node, its arbiters and its services", () => {
  it("in that order, once, on its update and on the launch's list its siblings read", async () => {
    const { node, live, tally } = setup({
      runner: () => Promise.resolve({ value: { x: 1 }, read: ["r"], usage: [record(0.5, "node")] }),
    });
    vi.mocked(markAnswer).mockImplementation(() => {
      servicesOf().push(record(0.125, "service"));
      return Promise.resolve({ usage: [record(0.25, "arbiter")] });
    });

    const out = await node(stateOf() as never, undefined);

    const usage = [record(0.5, "node"), record(0.25, "arbiter"), record(0.125, "service")];
    expect(tally).toHaveBeenCalledWith([record(0.25, "arbiter")]);
    expect(out.usage).toEqual(usage);
    expect(live.spent).toEqual(usage);
    expect(visitStepsOf).toHaveBeenCalledWith("site", {
      outcome: expect.objectContaining({ read: ["r"] }),
      usage,
    });
    expect(out).toMatchObject({
      visited: true,
      records: true,
      compensations: "opened",
      stepRecords: ["steps"],
      next: "join",
      startedVersion: "v1",
    });
  });

  it("a node with no usage and no arbiter spends nothing; the arbiters are tallied even when there are none", async () => {
    const { node, live, tally } = setup();
    vi.mocked(markAnswer).mockResolvedValue(undefined);

    const out = await node(stateOf() as never, undefined);

    expect(tally).toHaveBeenCalledWith([]);
    expect(out.usage).toEqual([]);
    expect(live.spent).toEqual([]);
  });

  it("the siblings that start later see what it spent on their state", async () => {
    const live = liveOf();
    const first = setup({
      live,
      runner: () => Promise.resolve({ read: [], usage: [record(0.5, "node")] }),
    });
    const second = setup({ live });
    vi.mocked(markAnswer).mockResolvedValue({ usage: [] });

    await first.node(stateOf() as never, undefined);
    await second.node(stateOf() as never, undefined);

    const [seen] = second.runner.mock.calls[0] ?? [];
    expect(seen?.usage).toEqual([record(1, "before"), record(0.5, "node")]);
  });

  it("finished, with its value, its verdict mark and what it read", async () => {
    const { node } = setup();
    vi.mocked(markAnswer).mockResolvedValue({ usage: [], mark: { verdict: "counted" } } as never);

    const out = await node(stateOf() as never, undefined);

    expect(out.branchRecords).toEqual({
      add: [
        {
          launchId: "L1",
          index: 2,
          status: BranchStatus.Finished,
          value: { x: 1 },
          read: ["r"],
          verdict: "counted",
        },
      ],
    });
  });

  it("an answer that gave no value has no value on its record", async () => {
    const { node } = setup({ runner: () => Promise.resolve({ read: [] }) });
    vi.mocked(markAnswer).mockResolvedValue(undefined);

    const out = await node(stateOf() as never, undefined);

    expect(Object.keys(addedOf(out)[0] ?? {})).not.toContain("value");
    expect(Object.keys(vi.mocked(settledEnd).mock.calls[0]?.[1] ?? {})).not.toContain("value");
  });

  it("a quorum decided while its arbiters checked it ends it cancelled, its spend kept", async () => {
    const { node, live } = setup({
      runner: () => Promise.resolve({ value: { x: 1 }, read: ["r"], usage: [record(0.5, "node")] }),
    });
    vi.mocked(markAnswer).mockResolvedValue({ usage: [record(0.25, "arbiter")] });

    const out = await node(stateOf() as never, undefined);

    expect(out.branchRecords).toEqual({
      add: [{ launchId: "L1", index: 2, status: BranchStatus.Cancelled, read: ["r"] }],
    });
    expect(out.usage).toEqual([record(0.5, "node"), record(0.25, "arbiter")]);
    expect(live.spent).toEqual([record(0.5, "node"), record(0.25, "arbiter")]);
  });

  it("checks its visit first, the arbiters after its node", async () => {
    const order: string[] = [];
    vi.mocked(checkVisit).mockImplementation(() => {
      order.push("visit");
      return Promise.resolve(true);
    });
    const { node } = setup({
      runner: () => {
        order.push("node");
        return Promise.resolve({ read: [] });
      },
    });
    vi.mocked(markAnswer).mockImplementation(() => {
      order.push("arbiters");
      return Promise.resolve({ usage: [] });
    });

    await node(stateOf() as never, undefined);

    expect(order).toEqual(["visit", "node", "arbiters"]);
    expect(recordBranchLostPasses).toHaveBeenCalledOnce();
  });
});

describe("#1366: a branch that failed carries the spend its error holds and its services", () => {
  const failing = (error: Error, status: BranchStatus, live = liveOf()) => {
    vi.mocked(failedStatusOf).mockReturnValue(status);
    return { ...setup({ live, runner: () => Promise.reject(error) }), live };
  };
  const paid = () =>
    new PaidStepError({
      message: "paid",
      usage: [record(0.5, "aborted")],
      cause: new Error("x"),
    });

  it("is written to its update and the launch's list, the services' after the error's", async () => {
    const { node, live } = failing(paid(), BranchStatus.Failed);
    vi.mocked(recordBranchLostPasses).mockImplementation((run) => {
      run.services.push(record(0.125, "lost"));
    });

    const out = await node(stateOf() as never, undefined);

    const usage = [record(0.5, "aborted"), record(0.125, "lost")];
    expect(out.usage).toEqual(usage);
    expect(live.spent).toEqual(usage);
    expect(failedVisitOf).toHaveBeenCalledWith("site", expect.any(PaidStepError), usage);
    expect(out).toMatchObject({ failedVisit: true, visited: true });
  });

  it("a failure that is not a paid one carries no spend of its own", async () => {
    const { node, live } = failing(new Error("plain"), BranchStatus.Failed);

    const out = await node(stateOf() as never, undefined);

    expect(out.usage).toEqual([]);
    expect(live.spent).toEqual([]);
  });

  it("a failed branch aborts its launch and keeps its error for the join, once under its index", async () => {
    const error = paid();
    const { node, live, keep } = failing(error, BranchStatus.Failed);

    const out = await node(stateOf() as never, undefined);

    expect(live.errors.get(2)).toBe(error);
    expect(keep).toHaveBeenCalledWith("L1", 2, error);
    expect(abortLaunch).toHaveBeenCalledOnce();
    expect(leaveQuorum).toHaveBeenCalledWith(live, expect.objectContaining({ index: 2 }));
    expect(addedOf(out)[0]?.read).toEqual([]);
    expect(out.branchRecords).toMatchObject({
      add: [
        {
          status: BranchStatus.Failed,
          error: expect.objectContaining({ code: expect.anything() }),
        },
      ],
    });
  });

  it("a launch with no store for the join's errors still aborts and keeps its own", async () => {
    const live = liveOf();
    vi.mocked(failedStatusOf).mockReturnValue(BranchStatus.Failed);
    const made = setup({ live, runner: () => Promise.reject(paid()) });
    const bare = branchNode(
      { id: "n" } as never,
      made.runner as never,
      {
        ...made.deps,
        branchErrors: undefined,
      } as never,
    );

    await bare(stateOf() as never, undefined);

    expect(live.errors.size).toBe(1);
    expect(abortLaunch).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "a branch that expired in a plain launch follows it: aborts",
      BranchStatus.Expired,
      false,
      "fail-fast",
      true,
    ],
    ["an expired branch of a quorum is dropped", BranchStatus.Expired, true, "fail-fast", false],
    [
      "an expired branch under Skip is dropped",
      BranchStatus.Expired,
      false,
      FailurePolicy.Skip,
      false,
    ],
    ["a skipped branch is dropped", BranchStatus.Skipped, false, "fail-fast", false],
    [
      "a cancelled branch is no failure of its own",
      BranchStatus.Cancelled,
      false,
      "fail-fast",
      false,
    ],
  ])("%s", async (_name, status, isQuorum, failure, aborts) => {
    const live = liveOf({
      quorum: isQuorum
        ? {
            withdrawal: { during: (work: () => unknown) => work() },
            ready: Promise.resolve(),
            queued: { excluded: () => 0 },
          }
        : undefined,
    });
    const made = failing(paid(), status, live);
    const { branchTicketOf } = await import("../../../src/flow/runtime/launch/branch-view.js");
    vi.mocked(branchTicketOf).mockReturnValue({ index: 2, nodeId: "n", failure } as never);

    const out = await made.node(stateOf() as never, undefined);

    expect(abortLaunch).toHaveBeenCalledTimes(aborts ? 1 : 0);
    expect(live.errors.size).toBe(aborts ? 1 : 0);
    expect(made.keep).toHaveBeenCalledTimes(aborts ? 1 : 0);
    expect(Object.keys(addedOf(out)[0] ?? {}).includes("error")).toBe(
      status !== BranchStatus.Cancelled,
    );
  });

  it("is told to the quorum, and a hand-over or cancel of the execution passes through with the error", async () => {
    const error = paid();
    const { node } = failing(error, BranchStatus.Failed);

    await node(stateOf() as never, { signal: undefined } as never);

    expect(passThroughStops).toHaveBeenCalledWith(expect.anything(), "run-1", error);
  });

  it("a failure before the branch's frame existed records no step of its own", async () => {
    const live = liveOf();
    vi.mocked(failedStatusOf).mockReturnValue(BranchStatus.Failed);
    const { branchFrameOf } = await import("../../../src/flow/runtime/launch/branch-view.js");
    vi.mocked(branchFrameOf).mockImplementation(() => {
      throw new Error("no frame");
    });
    const { node } = setup({ live });

    await node(stateOf() as never, undefined);

    expect(failedVisitOf).toHaveBeenCalledWith(undefined, expect.any(Error), []);
  });
});

describe("#1366: a branch cancelled before it ran keeps what it spent", () => {
  it("records its lost passes first, then waits for a slot; with none it ends cancelled with its services", async () => {
    const live = liveOf({
      slots: { acquire: vi.fn((_stop: AbortSignal) => Promise.resolve(false)), release: vi.fn() },
    });
    const { node, runner, started } = setup({ live });
    vi.mocked(recordBranchLostPasses).mockImplementation((run) => {
      run.services.push(record(0.125, "lost"));
    });

    const out = await node(stateOf() as never, undefined);

    expect(runner).not.toHaveBeenCalled();
    expect(started).not.toHaveBeenCalled();
    expect(out.usage).toEqual([record(0.125, "lost")]);
    expect(out.branchRecords).toEqual({
      add: [{ launchId: "L1", index: 2, status: BranchStatus.Cancelled, read: [] }],
    });
    expect(passThroughStops).toHaveBeenCalledWith(undefined, "run-1");
    expect(leaveQuorum).toHaveBeenCalledWith(live, expect.objectContaining({ index: 2 }));
    expect(live.slots.release).not.toHaveBeenCalled();
    expect(live.slots.acquire).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(vi.mocked(recordBranchLostPasses).mock.invocationCallOrder[0]).toBeLessThan(
      live.slots.acquire.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("a branch that took a slot gives it back when it ends, whatever way", async () => {
    const ok = setup();
    await ok.node(stateOf() as never, undefined);
    vi.mocked(failedStatusOf).mockReturnValue(BranchStatus.Skipped);
    const bad = setup({ runner: () => Promise.reject(new Error("x")) });
    await bad.node(stateOf() as never, undefined);

    expect(ok.live.slots.release).toHaveBeenCalledOnce();
    expect(bad.live.slots.release).toHaveBeenCalledOnce();
    expect(ok.started).toHaveBeenCalledWith("scheduled");
  });

  it("is stopped by the execution's signal or its launch's", async () => {
    const live = liveOf();
    const { node } = setup({ live });

    await node(stateOf() as never, undefined);

    const [stop] = live.slots.acquire.mock.calls[0] ?? [];
    expect(stop?.aborted).toBe(false);
    live.controller.abort();
    expect(stop?.aborted).toBe(true);
  });

  it("the execution's own signal stops it too", async () => {
    const execution = new AbortController();
    vi.mocked(executionSignalOf).mockReturnValue(execution.signal);
    const live = liveOf();
    const { node } = setup({ live });

    await node(stateOf() as never, undefined);

    const [stop] = live.slots.acquire.mock.calls[0] ?? [];
    expect(stop?.aborted).toBe(false);
    execution.abort();
    expect(stop?.aborted).toBe(true);
    expect(executionSignalOf).toHaveBeenCalledWith(undefined, "run-1");
  });

  it("reports how it ended", async () => {
    const { node } = setup();

    await node(stateOf() as never, undefined);

    expect(reportBranch).toHaveBeenCalledOnce();
  });
});

describe("#1366: what a branch is bounded by and opens as it ends", () => {
  it("a branch of a quorum runs under its quorum's deadline, moved by the time its branches waited in the queue", async () => {
    const quorum = {
      queued: { excluded: () => 40 },
      ready: Promise.resolve(),
      withdrawal: { during: (work: () => unknown) => work() },
    };
    const { node } = setup({ live: liveOf({ quorum }) });

    await node(stateOf() as never, undefined);

    expect(vi.mocked(withQuorumDeadline).mock.calls[0]?.[1]).toBe(1000);
    expect(vi.mocked(withQuorumDeadline).mock.calls[0]?.[2]).toBe(40);
  });

  it("a branch of no quorum has no deadline and no wait to exclude", async () => {
    const { node } = setup();

    await node(stateOf() as never, undefined);

    expect(vi.mocked(withQuorumDeadline).mock.calls[0]?.[1]).toBeUndefined();
    expect(vi.mocked(withQuorumDeadline).mock.calls[0]?.[2]).toBe(0);
  });

  it("an undoable branch opens its entry on its launch and its value as it ends", async () => {
    const { node } = setup();

    await node(stateOf() as never, undefined);

    expect(vi.mocked(compensationsOfBranch).mock.calls[0]?.[0]).toMatchObject({
      branch: { launchId: "L1", value: { x: 1 } },
    });
  });
});
