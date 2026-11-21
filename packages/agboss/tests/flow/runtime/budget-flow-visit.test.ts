/**
 * #1366 (budget-flow shard) — what a node's visit does with the budgets, each rule on its own over fakes: the
 * visit's limits are checked in its tree's slot before the node runs (and decide whether it counts as a step),
 * what the step's code paid services is added to the node's own usage, a failure carries the spend and its owed
 * undo's, and a limit thrown before the node ran holds the visit back.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CostSource, ZERO_USAGE, type UsageRecord } from "../../../src/finops/usage.js";
import { compensationsOfHeldVisit, compensationsOfVisit } from "../../../src/flow/compensation.js";
import { LimitExceededError } from "../../../src/graph/limits.js";
import { checkVisit } from "../../../src/flow/runtime/limits.js";
import { caught } from "../../../src/flow/runtime/visit-failure.js";
import { inTreeSlot } from "../../../src/flow/runtime/step-frame.js";
import { visitNode } from "../../../src/flow/runtime/visit.js";

vi.mock("../../../src/flow/runtime/limits.js", () => ({
  checkVisit: vi.fn(),
  isWorkingNode: vi.fn(() => true),
  sidePathAfter: vi.fn(() => ({})),
}));
vi.mock("../../../src/flow/runtime/step-frame.js", () => ({
  inTreeSlot: vi.fn((_slot: unknown, work: () => unknown) => work()),
  startedVersionOf: vi.fn(() => "v1"),
  stepFrameOf: vi.fn(() => ({
    execution: { executionId: "e1" },
    step: { component: "component" },
  })),
  visitNumberOf: vi.fn(() => 1),
}));
vi.mock("../../../src/flow/runtime/node-runner.js", () => ({
  reportingOf: vi.fn(),
  recordsOf: vi.fn(() => ({})),
}));
vi.mock("../../../src/flow/runtime/visit-failure.js", () => ({
  caught: vi.fn(),
  visited: vi.fn(() => ({ path: ["n"] })),
}));
vi.mock("../../../src/flow/compensation.js", () => ({
  compensationsOfVisit: vi.fn(() => Promise.resolve({})),
  compensationsOfHeldVisit: vi.fn(() => Promise.resolve({})),
}));
vi.mock("../../../src/flow/runtime/visit-write.js", () => ({
  visitWrite: vi.fn(() => ({ update: {}, outdated: [], cascades: [] })),
}));
vi.mock("../../../src/flow/runtime/visit-step.js", () => ({
  succeededStepsOf: vi.fn(() => ["steps"]),
}));
vi.mock("../../../src/flow/runtime/outdating-report.js", () => ({ reportOutdating: vi.fn() }));
vi.mock("../../../src/flow/runtime/launch/launch-exit.js", () => ({
  launchEdgeOf: vi.fn(),
  launchFor: vi.fn(() => undefined),
  launchTicketOf: vi.fn(),
  nextOfLaunch: vi.fn(),
}));
vi.mock("../../../src/flow/runtime/launch/launch-report.js", () => ({ reportTruncation: vi.fn() }));
vi.mock("../../../src/flow/runtime/scope.js", () => ({ readInput: vi.fn(() => ({ fields: {} })) }));
vi.mock("../../../src/flow/runtime/lost-pass-records.js", () => ({ recordLostPasses: vi.fn() }));
vi.mock("../../../src/flow/context/frame.js", () => ({
  runInFrame: vi.fn((_frame: unknown, work: () => unknown) => work()),
}));
vi.mock("../../../src/core/run-context.js", () => ({
  extractRunContext: vi.fn(() => ({ clock: { now: () => new Date("2026-11-21T12:00:00.000Z") } })),
}));
vi.mock("../../../src/flow/runtime/workflow-keys.js", () => ({ recordOfNode: vi.fn() }));

import { reportingOf } from "../../../src/flow/runtime/node-runner.js";
import { reportOutdating } from "../../../src/flow/runtime/outdating-report.js";
import { visitWrite } from "../../../src/flow/runtime/visit-write.js";
import {
  launchEdgeOf,
  launchFor,
  launchTicketOf,
  nextOfLaunch,
} from "../../../src/flow/runtime/launch/launch-exit.js";
import { reportTruncation } from "../../../src/flow/runtime/launch/launch-report.js";

/** A list an update gives: a plain one or an overwrite of one. */
const listOf = <T>(value: readonly T[] | object | undefined): T[] =>
  Array.isArray(value) ? (value as T[]) : [];

const record = (costUsd: number, caller = "x"): UsageRecord => ({
  ...ZERO_USAGE,
  caller,
  model: "m",
  costUsd,
  costSource: CostSource.Api,
});

const node = { id: "n", exits: { next: { to: "after" }, routes: new Map(), cases: new Map() } };
const stateOf = () =>
  ({ runId: "run-1", path: ["a"], outdatedValues: [], compensations: [] }) as never;

function setup(reportedUsage: UsageRecord[] = []) {
  const reported = { usage: reportedUsage, children: [], piiTokens: {}, compensations: [] };
  vi.mocked(reportingOf).mockReturnValue({ reported, services: {} });
  vi.mocked(checkVisit).mockResolvedValue(true);
  const deps = {
    limits: { budgets: {} },
    workflow: { name: "workflow" },
    provenance: {},
    graph: {},
    container: {},
    observer: undefined,
  };
  return { reported, deps };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("#1366: the limits of a visit", () => {
  it("are checked in the tree's slot, before the node runs, against the state and the step's component", async () => {
    const { deps } = setup();
    const order: string[] = [];
    vi.mocked(inTreeSlot).mockImplementation(((_slot: unknown, work: () => unknown) => {
      order.push("slot");
      return work();
    }) as never);
    vi.mocked(checkVisit).mockImplementation(() => {
      order.push("limits");
      return Promise.resolve(true);
    });
    const runner = vi.fn(() => {
      order.push("node");
      return Promise.resolve({ read: [] });
    });
    const state = stateOf();

    await visitNode(node as never, runner as never, deps as never)(state, undefined);

    expect(order).toEqual(["slot", "limits", "node"]);
    expect(checkVisit).toHaveBeenCalledWith(state, node, deps.limits, deps.workflow, "component");
  });

  it("a limit refuses the node: it never runs, and the failure is handled with the spend so far", async () => {
    const { deps } = setup();
    const limit = new LimitExceededError({
      key: "k",
      limit: 1,
      actual: 2,
      path: [],
      spentUsd: 0,
      usage: [],
    });
    vi.mocked(checkVisit).mockRejectedValue(limit);
    vi.mocked(caught).mockReturnValue({ usage: [record(0.5, "handled")] });
    const runner = vi.fn();

    const out = await visitNode(
      node as never,
      runner as never,
      deps as never,
    )(stateOf(), undefined);

    expect(runner).not.toHaveBeenCalled();
    expect(vi.mocked(caught).mock.calls[0]?.[3]).toMatchObject({ ranAsStep: false });
    expect(out.usage).toEqual([record(0.5, "handled")]);
  });

  it("whether the node counted as a step is what the limits said, handed to the failure's handler", async () => {
    const { deps } = setup();
    vi.mocked(checkVisit).mockResolvedValue(true);
    vi.mocked(caught).mockReturnValue({ usage: [] });
    const runner = vi.fn(() => Promise.reject(new Error("broke")));

    await visitNode(node as never, runner as never, deps as never)(stateOf(), undefined);

    expect(vi.mocked(caught).mock.calls[0]?.[3]).toMatchObject({ ranAsStep: true });
  });
});

describe("#1366: the spend of a visit", () => {
  it("is the node's usage, then what its code paid services", async () => {
    const { deps } = setup([record(0.125, "service")]);
    const runner = vi.fn(() => Promise.resolve({ read: [], usage: [record(0.5, "node")] }));

    const out = await visitNode(
      node as never,
      runner as never,
      deps as never,
    )(stateOf(), undefined);

    const { succeededStepsOf } = await import("../../../src/flow/runtime/visit-step.js");
    const seen = vi.mocked(succeededStepsOf).mock.calls[0]?.[1];
    expect(seen?.usage?.map((u) => u.caller)).toEqual(["node", "service"]);
    expect(out).toMatchObject({ stepRecords: ["steps"], next: "after", startedVersion: "v1" });
  });

  it("a node that gave no usage spends what its services paid", async () => {
    const { deps } = setup([record(0.125, "service")]);
    const runner = vi.fn(() => Promise.resolve({ read: [] }));

    await visitNode(node as never, runner as never, deps as never)(stateOf(), undefined);

    const { succeededStepsOf } = await import("../../../src/flow/runtime/visit-step.js");
    expect(vi.mocked(succeededStepsOf).mock.calls[0]?.[1].usage).toEqual([
      record(0.125, "service"),
    ]);
  });

  it("the node's own spend is registered for the services before it runs: the same list", async () => {
    const { deps, reported } = setup();
    const runner = vi.fn(() => {
      reported.usage.push(record(0.25, "late"));
      return Promise.resolve({ read: [] });
    });

    const out = await visitNode(
      node as never,
      runner as never,
      deps as never,
    )(stateOf(), undefined);

    expect(out.children).toEqual([]);
    expect(reportingOf).toHaveBeenCalledWith(deps.limits, node, ["a"]);
  });
});

describe("#1366: a failed visit's spend and its owed undo's", () => {
  const failing = (error: Error) => vi.fn(() => Promise.reject(error));

  it("the undo's spend follows the visit's own; the entries of a failed child come before the visit's own", async () => {
    const { deps, reported } = setup();
    reported.compensations.push("child-entry" as never);
    vi.mocked(caught).mockReturnValue({ usage: [record(0.5, "visit")] });
    vi.mocked(compensationsOfVisit).mockResolvedValue({
      compensations: ["own-entry"],
      usage: [record(0.25, "undo")],
    } as never);

    const out = await visitNode(
      node as never,
      failing(new Error("x")) as never,
      deps as never,
    )(stateOf(), undefined);

    expect(listOf(out.usage).map((u) => u.caller)).toEqual(["visit", "undo"]);
    expect(out.compensations).toEqual(["child-entry", "own-entry"]);
    expect(out.startedVersion).toBe("v1");
  });

  it("no entries add no key; a handled update with no usage still carries the undo's", async () => {
    const { deps } = setup();
    vi.mocked(caught).mockReturnValue({});
    vi.mocked(compensationsOfVisit).mockResolvedValue({ usage: [record(0.25, "undo")] } as never);

    const out = await visitNode(
      node as never,
      failing(new Error("x")) as never,
      deps as never,
    )(stateOf(), undefined);

    expect(Object.keys(out)).not.toContain("compensations");
    expect(out.usage).toEqual([record(0.25, "undo")]);
  });

  it("a visit held back by a limit runs its owed undo, not the plain one", async () => {
    const { deps } = setup();
    vi.mocked(checkVisit).mockRejectedValue(
      new LimitExceededError({
        key: "k",
        limit: 1,
        actual: 2,
        path: [],
        spentUsd: 0,
        usage: [],
      }),
    );
    vi.mocked(caught).mockReturnValue({});
    vi.mocked(compensationsOfHeldVisit).mockResolvedValue({
      usage: [record(0.25, "held")],
    });

    const out = await visitNode(
      node as never,
      vi.fn() as never,
      deps as never,
    )(stateOf(), undefined);

    expect(compensationsOfHeldVisit).toHaveBeenCalledOnce();
    expect(compensationsOfVisit).not.toHaveBeenCalled();
    expect(out.usage).toEqual([record(0.25, "held")]);
  });

  it("a limit thrown by the node itself, after the limits passed, is no held-back visit", async () => {
    const { deps } = setup();
    vi.mocked(caught).mockReturnValue({});
    vi.mocked(compensationsOfVisit).mockResolvedValue({});
    const limit = new LimitExceededError({
      key: "k",
      limit: 1,
      actual: 2,
      path: [],
      spentUsd: 0,
      usage: [],
    });

    await visitNode(node as never, failing(limit) as never, deps as never)(stateOf(), undefined);

    expect(compensationsOfVisit).toHaveBeenCalledOnce();
    expect(compensationsOfHeldVisit).not.toHaveBeenCalled();
  });

  it("another failure before the limits passed is no held-back visit either", async () => {
    const { deps } = setup();
    vi.mocked(checkVisit).mockRejectedValue(new Error("not a limit"));
    vi.mocked(caught).mockReturnValue({});
    vi.mocked(compensationsOfVisit).mockResolvedValue({});

    await visitNode(node as never, vi.fn() as never, deps as never)(stateOf(), undefined);

    expect(compensationsOfVisit).toHaveBeenCalledOnce();
  });
});

describe("#1366: what a visit reports", () => {
  it("the children its code ran are the visit's, the undo's entries too", async () => {
    const { deps, reported } = setup();
    reported.children.push({ child: 1 } as never);
    vi.mocked(compensationsOfVisit).mockResolvedValue({ compensations: ["e"] } as never);

    const out = await visitNode(
      node as never,
      vi.fn(() => Promise.resolve({ read: [] })) as never,
      deps as never,
    )(stateOf(), undefined);

    expect(out.children).toEqual([{ child: 1 }]);
    expect(out.compensations).toEqual(["e"]);
  });

  it("the outdated values so far are the state's and this write's, told with the cascades", async () => {
    const { deps } = setup();
    vi.mocked(visitWrite).mockReturnValue({
      update: {},
      outdated: ["w"],
      cascades: ["c"],
    } as never);
    const state = { ...(stateOf() as object), outdatedValues: ["s"] } as never;

    await visitNode(
      node as never,
      vi.fn(() => Promise.resolve({ read: [] })) as never,
      deps as never,
    )(state, undefined);

    expect(reportOutdating).toHaveBeenCalledWith(
      ["c"],
      expect.objectContaining({ outdatedSoFar: ["s", "w"] }),
    );
  });

  it("the owed undo is run with the instance's compensation parts, a done visit's too", async () => {
    const { deps } = setup();
    const parts = { registry: true };
    const withParts = { ...deps, compensation: parts };

    await visitNode(
      node as never,
      vi.fn(() => Promise.resolve({ read: [] })) as never,
      withParts as never,
    )(stateOf(), undefined);

    expect(vi.mocked(compensationsOfVisit).mock.calls[0]?.[0]).toMatchObject({ parts });
  });

  it("a visit that launched tells the truncation of its items, from the launch's own maximum", async () => {
    const { deps } = setup();
    const launch = { launch: { maxItems: 7 } };
    const ticket = { launchId: "L1" };
    vi.mocked(launchFor).mockReturnValue(launch as never);
    vi.mocked(launchEdgeOf).mockReturnValue({ to: "x" } as never);
    vi.mocked(launchTicketOf).mockReturnValue(ticket as never);
    vi.mocked(nextOfLaunch).mockReturnValue("<launch>");

    const out = await visitNode(
      node as never,
      vi.fn(() => Promise.resolve({ read: [] })) as never,
      deps as never,
    )(stateOf(), undefined);

    expect(reportTruncation).toHaveBeenCalledWith(
      expect.objectContaining({ observer: undefined }),
      ticket,
      7,
    );
    expect(out).toMatchObject({ next: "<launch>", launch: ticket });
  });

  it("a visit that launched nothing tells nothing of truncation", async () => {
    const { deps } = setup();

    await visitNode(
      node as never,
      vi.fn(() => Promise.resolve({ read: [] })) as never,
      deps as never,
    )(stateOf(), undefined);

    expect(reportTruncation).not.toHaveBeenCalled();
  });
});
