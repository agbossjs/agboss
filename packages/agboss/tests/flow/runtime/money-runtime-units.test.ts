/**
 * #1356 (money-runtime shard) — the rules by which a run's spend is counted where it is made, each on its own:
 * which visits the budgets check (#656) and the limits of steps and visits, a service's spend counted at once
 * (#338), a child's own spend and how its failure reaches its parent, the router's spend counted at the call
 * (#1090), the ledger ids of lost passes (#853), the spend a failure carries and the run's drain of it, what a
 * paused run has spent (#267).
 */
import { GraphInterrupt } from "@langchain/langgraph";
import { describe, expect, it, vi } from "vitest";
import { ApplicationStoppingError, ExecutionCancelledError } from "../../../src/core/errors.js";
import { errorRecordOf, RecordedError } from "../../../src/core/error-record.js";
import { CostSource, ZERO_USAGE, type UsageRecord } from "../../../src/finops/usage.js";
import { NodeKind } from "../../../src/flow/ast.js";
import {
  CompensationEntryStatus,
  CompensationFailedError,
} from "../../../src/flow/compensation.js";
import { ChildExecutionFailedError } from "../../../src/flow/runtime/child-errors.js";
import {
  childFailureOf,
  isRecordedAs,
  ownUsageOf,
  type EndedChild,
} from "../../../src/flow/runtime/child-exit.js";
import { ChildExecutionStatus } from "../../../src/flow/runtime/child-records.js";
import {
  checkVisit,
  countedServiceSpend,
  isWorkingNode,
  type ExecutionLimits,
} from "../../../src/flow/runtime/limits.js";
import {
  unknownCostRecordsOf,
  unknownLedgerIdOf,
} from "../../../src/flow/runtime/lost-pass-records.js";
import { unrecordedSpendOf } from "../../../src/flow/runtime/node-runner.js";
import { VisitsLimitExceededError } from "../../../src/flow/runtime/errors.js";
import { counterOf } from "../../../src/flow/runtime/runners/router.js";
import {
  StepsLimitExceededError,
  BudgetExceededError,
  LimitExceededError,
} from "../../../src/graph/limits.js";
import { PaidStepError } from "../../../src/graph/errors.js";
import { BudgetScope } from "../../../src/index.js";
import { drainRun } from "../../../src/run/execute.js";
import { pausedUsageOf } from "../../../src/run/paused.js";
import { usd } from "../../../src/units/index.js";

const record = (costUsd: number, model = "m"): UsageRecord => ({
  ...ZERO_USAGE,
  caller: "agent:a",
  model,
  costUsd,
  costSource: CostSource.Api,
});

const node = (id: string, kind: NodeKind, maxVisits?: number) =>
  ({
    id,
    kind,
    component: Object,
    ...(maxVisits === undefined ? {} : { maxVisits }),
  }) as never;

const WORKFLOW = { name: "flow", version: "v2", configHash: "hash" } as never;
const COMPONENT = { name: "clerk", kind: "agent", promptHash: "p", schemaHash: "s" } as never;

const stateOf = (changes: Record<string, unknown> = {}) =>
  ({
    path: ["start"],
    usage: [record(0.5), record(0.25)],
    visits: {},
    steps: 0,
    startedVersion: "",
    sidePath: null,
    compensations: [],
    ...changes,
  }) as never;

const limitsOf = (maxSteps = 10) => {
  const calls: string[] = [];
  const budgets = {
    refresh: vi.fn(() => {
      calls.push("refresh");
      return Promise.resolve();
    }),
    check: vi.fn((..._args: unknown[]) => {
      calls.push("check");
    }),
    tally: vi.fn((records: readonly UsageRecord[]) => records),
  };
  return { limits: { maxSteps, budgets } as never as ExecutionLimits, budgets, calls };
};

const visit = (state: never, target: never, limits: ExecutionLimits) =>
  checkVisit(state, target, limits, WORKFLOW, COMPONENT);

const caught = async (work: () => Promise<unknown>): Promise<unknown> => {
  try {
    await work();
  } catch (error) {
    return error;
  }
  return undefined;
};

describe("#1356: which nodes are steps", () => {
  it("an agent and a router are; the rest are not", () => {
    expect(isWorkingNode(node("a", NodeKind.Agent))).toBe(true);
    expect(isWorkingNode(node("r", NodeKind.Router))).toBe(true);
    for (const kind of [
      NodeKind.Action,
      NodeKind.Question,
      NodeKind.Workflow,
      NodeKind.Start,
      NodeKind.Finish,
    ])
      expect(isWorkingNode(node("x", kind))).toBe(false);
  });
});

describe("#1356: the limits of a visit", () => {
  it("fails a visit past the node's maxVisits with its path and what was spent, and lets the last one through", async () => {
    const { limits } = limitsOf();

    const error = await caught(() =>
      visit(stateOf({ visits: { clerk: 2 } }), node("clerk", NodeKind.Agent, 2), limits),
    );

    expect(error).toBeInstanceOf(VisitsLimitExceededError);
    expect(error).toMatchObject({
      maxVisits: 2,
      visits: 3,
      path: ["start", "clerk"],
      spentUsd: 0.75,
      component: { name: "clerk", kind: "agent", promptHash: "p", schemaHash: "s" },
    });
    await expect(
      visit(stateOf({ visits: { clerk: 1 } }), node("clerk", NodeKind.Agent, 2), limits),
    ).resolves.toBe(true);
  });

  it("counts the first visit of a node with no count yet, and holds a node with no maxVisits to none", async () => {
    const { limits } = limitsOf();

    await expect(visit(stateOf(), node("clerk", NodeKind.Agent, 1), limits)).resolves.toBe(true);
    await expect(
      visit(stateOf({ visits: { clerk: 99 } }), node("clerk", NodeKind.Agent), limits),
    ).resolves.toBe(true);
    expect(
      await caught(() => visit(stateOf(), node("clerk", NodeKind.Agent, 0), limits)),
    ).toBeInstanceOf(VisitsLimitExceededError);
  });

  it("#1365: refuses a node whose maxVisits is null on its first visit, with a bound of 0", async () => {
    const { limits } = limitsOf();
    const nullBound = {
      id: "clerk",
      kind: NodeKind.Agent,
      component: Object,
      maxVisits: null,
    } as never;

    const error = await caught(() => visit(stateOf(), nullBound, limits));

    expect(error).toBeInstanceOf(VisitsLimitExceededError);
    expect(error).toMatchObject({ maxVisits: 0, visits: 1, path: ["start", "clerk"] });
  });

  it.each([
    ["NaN", Number.NaN],
    ["a word", "five"],
    ["an object", { visits: 5 }],
    ["an array", []],
    ["a negative number", -1],
    ["a fraction", 1.5],
    ["a number as text", "2"],
    ["true", true],
    ["infinity", Number.POSITIVE_INFINITY],
  ])(
    "#1373: refuses a node whose maxVisits is %s on its first visit, with a bound of 0 (an agent, a router and a question)",
    async (_kind, value) => {
      const { limits, calls } = limitsOf();

      for (const kind of [NodeKind.Agent, NodeKind.Router, NodeKind.Question]) {
        const bad = {
          id: "clerk",
          kind,
          component: Object,
          maxVisits: value,
        } as never;

        const error = await caught(() => visit(stateOf(), bad, limits));

        expect(error).toBeInstanceOf(VisitsLimitExceededError);
        expect(error).toMatchObject({ maxVisits: 0, visits: 1, path: ["start", "clerk"] });
        expect((error as Error).message).not.toContain("five");
      }
      expect(calls).toEqual([]);
    },
  );

  it.each([
    ["NaN", Number.NaN],
    ["a word", "five"],
    ["an object", { steps: 5 }],
    ["null", null],
    ["a negative number", -1],
    ["a fraction", 1.5],
    ["infinity", Number.POSITIVE_INFINITY],
  ])(
    "#1373: a maxSteps that is %s is a bound of 0: the first step is refused, and the error names no text",
    async (_kind, value) => {
      const { limits } = limitsOf(value as never);

      for (const kind of [NodeKind.Agent, NodeKind.Router]) {
        const error = await caught(() => visit(stateOf(), node("clerk", kind), limits));

        expect(error).toBeInstanceOf(StepsLimitExceededError);
        expect(error).toMatchObject({ maxSteps: 0, steps: 1, path: ["start", "clerk"] });
        expect((error as Error).message).not.toContain("five");
      }
      await expect(visit(stateOf(), node("act", NodeKind.Action), limits)).resolves.toBe(false);
    },
  );

  it("#1373: a maxSteps of 0 refuses the first step too, and one of 3 lets the third step through", async () => {
    const zero = limitsOf(0).limits;
    const three = limitsOf(3).limits;

    expect(
      await caught(() => visit(stateOf(), node("clerk", NodeKind.Agent), zero)),
    ).toBeInstanceOf(StepsLimitExceededError);
    await expect(visit(stateOf({ steps: 2 }), node("clerk", NodeKind.Agent), three)).resolves.toBe(
      true,
    );
  });

  it("holds a question to its own maxVisits, and an action or a start to none", async () => {
    const { limits } = limitsOf();
    const state = stateOf({ visits: { ask: 3, act: 3, begin: 3 } });

    expect(
      await caught(() => visit(state, node("ask", NodeKind.Question, 3), limits)),
    ).toBeInstanceOf(VisitsLimitExceededError);
    await expect(visit(state, node("act", NodeKind.Action, 1), limits)).resolves.toBe(false);
    await expect(visit(state, node("begin", NodeKind.Start, 1), limits)).resolves.toBe(false);
  });

  it("fails the step past maxSteps — an agent's and a router's — with the version the execution started on", async () => {
    const { limits } = limitsOf(3);

    const error = await caught(() =>
      visit(stateOf({ steps: 3, startedVersion: "v1" }), node("clerk", NodeKind.Agent), limits),
    );

    expect(error).toBeInstanceOf(StepsLimitExceededError);
    expect(error).toMatchObject({
      maxSteps: 3,
      steps: 4,
      path: ["start", "clerk"],
      spentUsd: 0.75,
      workflow: { name: "flow", version: "v2", startedVersion: "v1", configHash: "hash" },
    });
    const fresh = await caught(() =>
      visit(stateOf({ steps: 3 }), node("route", NodeKind.Router), limits),
    );
    expect(fresh).toMatchObject({ workflow: { startedVersion: "v2" } });
    await expect(visit(stateOf({ steps: 2 }), node("clerk", NodeKind.Agent), limits)).resolves.toBe(
      true,
    );
  });

  it("counts no step for a question or an action", async () => {
    const { limits } = limitsOf(1);

    await expect(
      visit(stateOf({ steps: 5 }), node("ask", NodeKind.Question), limits),
    ).resolves.toBe(false);
    await expect(visit(stateOf({ steps: 5 }), node("act", NodeKind.Action), limits)).resolves.toBe(
      false,
    );
  });

  it("says the visits first when both limits are crossed", async () => {
    const { limits } = limitsOf(1);

    const error = await caught(() =>
      visit(stateOf({ steps: 5, visits: { clerk: 1 } }), node("clerk", NodeKind.Agent, 1), limits),
    );

    expect(error).toBeInstanceOf(VisitsLimitExceededError);
  });
});

describe("#1356: which visits the budgets check", () => {
  it("refreshes, then checks the spend so far at the visit's path, for an agent, a router, a question, an action and a workflow", async () => {
    for (const kind of [
      NodeKind.Agent,
      NodeKind.Router,
      NodeKind.Question,
      NodeKind.Action,
      NodeKind.Workflow,
    ]) {
      const { limits, budgets, calls } = limitsOf();
      const state = stateOf();

      await visit(state, node("n", kind), limits);

      expect(calls).toEqual(["refresh", "check"]);
      expect(budgets.check).toHaveBeenCalledWith((state as { usage: unknown }).usage, [
        "start",
        "n",
      ]);
    }
  });

  it("checks no start and no finish", async () => {
    for (const kind of [NodeKind.Start, NodeKind.Finish]) {
      const { limits, calls } = limitsOf();

      await expect(visit(stateOf(), node("n", kind), limits)).resolves.toBe(false);

      expect(calls).toEqual([]);
    }
  });

  const entry = (
    compensator: string,
    key: string,
    status = CompensationEntryStatus.Open,
    sequence = 1,
  ) => ({
    key,
    compensator,
    status,
    sequence,
  });

  it("checks no action of the side path that took a limit; any other action it checks", async () => {
    const onSide = (isAfterLimit: boolean, next = "act") =>
      stateOf({ sidePath: { next, isAfterLimit, owed: [] } });
    for (const [state, expected] of [
      [onSide(true), []],
      [onSide(false), ["refresh", "check"]],
      [onSide(true, "elsewhere"), ["refresh", "check"]],
      [stateOf(), ["refresh", "check"]],
    ] as const) {
      const { limits, calls } = limitsOf();

      await visit(state, node("act", NodeKind.Action), limits);

      expect(calls).toEqual(expected);
    }
  });

  it("checks an agent, a router or a question on the side path that took a limit: only an action goes past the budgets", async () => {
    for (const kind of [NodeKind.Agent, NodeKind.Router, NodeKind.Question, NodeKind.Workflow]) {
      const { limits, calls } = limitsOf();

      await visit(
        stateOf({ sidePath: { next: "n", isAfterLimit: true, owed: [] } }),
        node("n", kind),
        limits,
      );

      expect(calls).toEqual(["refresh", "check"]);
    }
  });

  it("checks no action that undoes the newest open entry the side path owes, and checks one that does not", async () => {
    const side = (owed: string[]) => ({ next: "undo", isAfterLimit: false, owed });
    for (const [compensations, owed, expected] of [
      [[entry("undo", "k1")], ["k1"], []],
      [[entry("undo", "k1")], [], ["refresh", "check"]],
      [[entry("other", "k1")], ["k1"], ["refresh", "check"]],
      [[entry("undo", "k1", CompensationEntryStatus.Closed)], ["k1"], ["refresh", "check"]],
      [
        [
          entry("undo", "k1", CompensationEntryStatus.Open, 1),
          entry("undo", "k2", CompensationEntryStatus.Open, 2),
        ],
        ["k1"],
        ["refresh", "check"],
      ],
      [
        [
          entry("undo", "k2", CompensationEntryStatus.Open, 2),
          entry("undo", "k1", CompensationEntryStatus.Open, 1),
        ],
        ["k2"],
        [],
      ],
      [[], ["k1"], ["refresh", "check"]],
    ] as const) {
      const { limits, calls } = limitsOf();

      await visit(
        stateOf({ sidePath: side([...owed]), compensations: [...compensations] }),
        node("undo", NodeKind.Action),
        limits,
      );

      expect(calls).toEqual(expected);
    }
  });
});

describe("#1356: a service's spend counted at once", () => {
  it("is named by the step, tallied in the budgets at the step's path, and what the budgets kept is returned", () => {
    const { limits, budgets } = limitsOf();
    const kept = record(9);
    budgets.tally.mockReturnValueOnce([kept]);

    const result = countedServiceSpend(limits, node("clerk", NodeKind.Agent), ["start"], record(1));

    expect(budgets.tally).toHaveBeenCalledWith(
      [{ ...record(1), caller: "agent:clerk" }],
      ["start", "clerk"],
    );
    expect(result).toBe(kept);
  });

  it("returns the named record when the budgets keep none", () => {
    const { limits, budgets } = limitsOf();
    budgets.tally.mockReturnValueOnce([]);

    expect(countedServiceSpend(limits, node("act", NodeKind.Action), [], record(1))).toEqual({
      ...record(1),
      caller: "action:act",
    });
  });
});

describe("#1356: the router's spend counted at the call", () => {
  it("is tallied first, then checked against the spend so far and what was kept, and returned as kept", () => {
    const order: string[] = [];
    const kept = [record(2)];
    const budgets = {
      tally: vi.fn(() => {
        order.push("tally");
        return kept;
      }),
      check: vi.fn((..._args: unknown[]) => {
        order.push("check");
      }),
    };
    const spent = [record(1)];

    const result = counterOf(budgets as never, spent, ["a", "b"])([record(3)]);

    expect(order).toEqual(["tally", "check"]);
    expect(budgets.tally).toHaveBeenCalledWith([record(3)], ["a", "b"]);
    expect(budgets.check).toHaveBeenCalledWith(spent, ["a", "b"], kept);
    expect(result).toBe(kept);
  });

  it("stops at the call when the budget is exhausted", () => {
    const budgets = {
      tally: () => [],
      check: () => {
        throw new Error("exhausted");
      },
    };

    expect(() => counterOf(budgets as never, [], [])([])).toThrow("exhausted");
  });
});

describe("#1356: the ledger ids of lost passes", () => {
  it("names the execution, the step, the task and the pass", () => {
    expect(unknownLedgerIdOf("root", "clerk", "task-1", 3)).toBe("unknown:root:clerk:task-1:3");
  });

  it("makes one record of unknown cost with no amount per lost pass, under that pass's identity, caller and time", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");

    const records = unknownCostRecordsOf(
      { rootExecutionId: "root", checkpointId: "c", tokens: [1, 4], settledTaskIds: [] },
      { nodeId: "clerk", taskId: "task-1", caller: "agent:clerk" },
      now,
    );

    expect(records).toStrictEqual([
      {
        ...ZERO_USAGE,
        caller: "agent:clerk",
        model: "unknown",
        costUsd: 0,
        costSource: CostSource.Unknown,
        ledgerKey: { id: "unknown:root:clerk:task-1:1", madeAt: now },
      },
      {
        ...ZERO_USAGE,
        caller: "agent:clerk",
        model: "unknown",
        costUsd: 0,
        costSource: CostSource.Unknown,
        ledgerKey: { id: "unknown:root:clerk:task-1:4", madeAt: now },
      },
    ]);
  });
});

describe("#1356: the spend a failure carries", () => {
  const spent = [record(1)];

  it("is a paid step's or a limit's own usage, and none for any other error or a non-error", () => {
    const limit = new BudgetExceededError({
      budget: { name: "b" },
      scope: BudgetScope.Tenant,
      key: "acme",
      maxSpend: usd(1),
      spent: usd(2),
      path: [],
      spentUsd: 2,
      usage: spent,
    });

    expect(
      unrecordedSpendOf(new PaidStepError({ message: "p", usage: spent, cause: undefined })),
    ).toBe(spent);
    expect(unrecordedSpendOf(limit)).toBe(limit.usage);
    expect(unrecordedSpendOf(new Error("plain"))).toEqual([]);
    expect(unrecordedSpendOf({ usage: spent })).toEqual([]);
    expect(unrecordedSpendOf(undefined)).toEqual([]);
  });

  it("is recorded by a run's drain before the failure rises, a paid one's and a limit's; a plain failure records none", async () => {
    const states = (error: unknown) =>
      (async function* () {
        yield { usage: [record(1)] } as never;
        yield { __interrupt__: [] } as never;
        throw error;
      })();
    const paid = new PaidStepError({ message: "p", usage: [record(7)], cause: undefined });
    for (const [error, expected] of [
      [paid, [record(7)]],
      [new Error("plain"), []],
    ] as const) {
      const recorded: (readonly UsageRecord[])[] = [];
      let isDone = false;
      const write = async (records: readonly UsageRecord[]) => {
        await Promise.resolve();
        recorded.push(records);
        isDone = recorded.length === 2;
      };

      await expect(drainRun(states(error), write)).rejects.toBe(error);

      expect(isDone).toBe(true);
      expect(recorded).toEqual([[record(1)], expected]);
    }
  });

  it("records a limit's spend too, and returns the last state of a run that ends", async () => {
    const limit = new LimitExceededError({
      key: "k",
      limit: 1,
      actual: 2,
      path: [],
      spentUsd: 0,
      usage: [record(5)],
      message: "m",
    });
    const recorded: (readonly UsageRecord[])[] = [];
    const write = (records: readonly UsageRecord[]) => {
      recorded.push(records);
      return Promise.resolve();
    };
    const failing = (async function* () {
      yield* [];
      throw limit;
    })();

    await expect(drainRun(failing, write)).rejects.toBe(limit);
    expect(recorded).toEqual([[record(5)]]);

    const last = { usage: [record(2)] } as never;
    await expect(
      drainRun(
        (async function* () {
          yield last;
        })(),
        write,
        [record(2)],
      ),
    ).resolves.toBe(last);
    expect(recorded.at(-1)).toEqual([]);
  });
});

describe("#1356: what a paused run has spent", () => {
  it("is the flow's usage and each loop's, in that order, each once", () => {
    const loop = (...usage: UsageRecord[]) => ({ usage }) as never;

    expect(pausedUsageOf([record(1)], [loop(record(2), record(3)), loop(record(4))])).toEqual([
      record(1),
      record(2),
      record(3),
      record(4),
    ]);
    expect(pausedUsageOf([], [])).toEqual([]);
    expect(pausedUsageOf([record(1)], [])).toEqual([record(1)]);
  });
});

describe("#1356: a child's own spend", () => {
  const identity = (inheritedUsage: number) =>
    ({
      executionId: "child-1",
      parentExecutionId: "parent",
      rootExecutionId: "parent",
      inheritedUsage,
    }) as never;

  it("is what its state holds past what it inherited, and none without a state", () => {
    const state = { usage: [record(1), record(2), record(3)] } as never;

    expect(ownUsageOf(state, identity(1))).toEqual([record(2), record(3)]);
    expect(ownUsageOf(state, identity(0))).toHaveLength(3);
    expect(ownUsageOf(undefined, identity(0))).toEqual([]);
  });
});

describe("#1356: how a child's failure reaches its parent", () => {
  const ended: EndedChild = {
    identity: {
      executionId: "child-1",
      parentExecutionId: "parent",
      rootExecutionId: "parent",
      inheritedUsage: 0,
    },
    depth: 1,
    workflow: { name: "pay", version: "v1", startedVersion: "v1", configHash: "h" },
    launchedBy: { nodeId: "pay", visitNumber: 1 },
    start: "pay-start",
    input: {},
    records: { components: new Map(), graph: { nodes: new Map() } },
  };
  const spent = [record(1)];
  const budgetError = (usage: UsageRecord[] = [record(2)]) =>
    new BudgetExceededError({
      budget: { name: "b" },
      scope: BudgetScope.Tenant,
      key: "acme",
      maxSpend: usd(1),
      spent: usd(2),
      path: [],
      spentUsd: 2,
      usage,
    });
  const through = (error: unknown, signal: AbortSignal = new AbortController().signal) =>
    childFailureOf(error, ended, spent, signal);

  it("lets a pause rise as it is", () => {
    const pause = new GraphInterrupt();

    expect(() => through(pause)).toThrow(pause);
  });

  it("lets a hand-over rise, the signal's reason or the error's", () => {
    const stopping = new ApplicationStoppingError({ message: "stopping" });
    const controller = new AbortController();
    controller.abort(stopping);

    expect(() => through(new Error("any"), controller.signal)).toThrow(stopping);
  });

  it("gives a cancellation's error as it is, its spend and the child's reported to the parent", () => {
    const cancelled = new ExecutionCancelledError({ message: "stop" });
    const own = new PaidStepError({ message: "p", usage: [record(3)], cause: undefined });

    expect(through(cancelled)).toEqual({
      thrown: cancelled,
      status: ChildExecutionStatus.Cancelled,
      usage: spent,
      reported: spent,
    });
    const controller = new AbortController();
    controller.abort(new Error("fail fast"));
    const aborted = through(own, controller.signal);
    expect(aborted.thrown).toBeInstanceOf(ExecutionCancelledError);
    expect(aborted.thrown).toMatchObject({ message: "child execution child-1 was cancelled" });
    expect(aborted).toMatchObject({
      status: ChildExecutionStatus.Cancelled,
      usage: [record(1), record(3)],
      reported: [record(1), record(3)],
    });
  });

  it("gives a budget's error as it is with the child's spend in front of its own, nothing reported (the error carries it)", () => {
    const error = budgetError([record(2)]);

    const failure = through(error);

    expect(failure.thrown).toBe(error);
    expect(error.usage).toEqual([record(1), record(2)]);
    expect(Object.prototype.propertyIsEnumerable.call(error, "usage")).toBe(true);
    expect(failure).toMatchObject({ status: ChildExecutionStatus.Failed, reported: [] });
    expect(failure.usage).toEqual([record(1), record(2)]);
  });

  it("gives a budget's rebuilt error as it is and reports the spend, because nothing carries it", () => {
    const rebuilt = new RecordedError(errorRecordOf(budgetError()));

    expect(through(rebuilt)).toEqual({
      thrown: rebuilt,
      status: ChildExecutionStatus.Failed,
      usage: spent,
      reported: spent,
    });
  });

  it("gives a failed undo's error, built or rebuilt, as it is and reports nothing", () => {
    const undo = new CompensationFailedError({ failures: [], cause: new Error("declined") });
    const rebuilt = new RecordedError(errorRecordOf(undo));

    for (const error of [undo, rebuilt])
      expect(through(error)).toEqual({
        thrown: error,
        status: ChildExecutionStatus.Failed,
        usage: spent,
        reported: [],
      });
  });

  it("wraps any other failure in the child's failed execution, with its cause and the spend, reporting nothing", () => {
    const cause = new PaidStepError({ message: "p", usage: [record(3)], cause: undefined });

    const failure = through(cause);

    expect(failure.thrown).toBeInstanceOf(ChildExecutionFailedError);
    expect(failure.thrown).toMatchObject({
      childExecutionId: "child-1",
      cause,
      workflow: { name: "pay", version: "v1", startedVersion: "v1", configHash: "h" },
      usage: [record(1), record(3)],
    });
    expect(failure).toMatchObject({
      status: ChildExecutionStatus.Failed,
      usage: [record(1), record(3)],
      reported: [],
    });
    expect(through("text").thrown).toBeInstanceOf(ChildExecutionFailedError);
  });

  it("knows a rebuilt error by its class line, and no other error or text", () => {
    const rebuilt = new RecordedError(errorRecordOf(budgetError()));

    expect(isRecordedAs(rebuilt, BudgetExceededError.code)).toBe(true);
    expect(isRecordedAs(rebuilt, CompensationFailedError.code)).toBe(false);
    expect(isRecordedAs(budgetError(), BudgetExceededError.code)).toBe(false);
    expect(isRecordedAs("limit.budget", BudgetExceededError.code)).toBe(false);
  });
});
