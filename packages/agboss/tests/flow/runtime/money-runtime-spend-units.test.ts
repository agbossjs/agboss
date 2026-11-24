import { usd } from "../../../src/units/index.js";
/**
 * #1366 (money-runtime shard) — where a run's spend is recorded, forwarded or carried in the flow runtime, each rule on
 * its own over fakes: what a visit's records and its code's services report, what a router's visit spends (the masking
 * and the guardrails counted at the call, the decision's too, a failure carrying all of it), the lost passes a step
 * records, the cost a child's record reports, the cost of a turn that is running or failed and the spend of a paused loop.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CostSource, ZERO_USAGE, type UsageRecord } from "../../../src/finops/usage.js";
import { NodeKind } from "../../../src/flow/ast.js";
import { childRecordOf, type EndedChild } from "../../../src/flow/runtime/child-exit.js";
import { ChildExecutionStatus } from "../../../src/flow/runtime/child-records.js";
import {
  LOST_PASSES_KEY,
  lostPassesOf,
  lostTokensOfTask,
  recordBranchLostPasses,
  recordLostPasses,
} from "../../../src/flow/runtime/lost-pass-records.js";
import { recordsOf, reportingOf } from "../../../src/flow/runtime/node-runner.js";
import { countedServiceSpend } from "../../../src/flow/runtime/limits.js";
import { routerRunner } from "../../../src/flow/runtime/runners/router.js";
import { RouterDecisionError, RouterFailedError } from "../../../src/flow/runtime/router-error.js";
import { failedOutcome, runningOutcome } from "../../../src/run/execute.js";
import { loopOf } from "../../../src/run/paused.js";
import { modelRouterLaunch } from "../../../src/flow/runtime/launch/router-decision.js";
import { maskedModelText } from "../../../src/pii/model-boundary.js";
import { runGuardrails } from "../../../src/guardrails/runtime.js";
import { boundaryInputOf } from "../../../src/flow/runtime/runners/boundary-input.js";
import { formatMemory, readerMemoryOf } from "../../../src/flow/runtime/history.js";
import { reportNodeEvent } from "../../../src/flow/observers/execution-event.js";

vi.mock("../../../src/flow/runtime/limits.js", () => ({ countedServiceSpend: vi.fn() }));
vi.mock("../../../src/flow/runtime/history.js", async (original) => ({
  ...(await original<typeof import("../../../src/flow/runtime/history.js")>()),
  readerMemoryOf: vi.fn(() => ({ summaries: [], history: [] })),
  formatMemory: vi.fn(() => ""),
}));
vi.mock("../../../src/flow/runtime/runners/boundary-input.js", () => ({
  boundaryInputOf: vi.fn(() => ({
    input: "the input",
    pii: { values: [], key: null, tokens: {} },
  })),
}));
vi.mock("../../../src/pii/model-boundary.js", () => ({ maskedModelText: vi.fn() }));
vi.mock("../../../src/guardrails/runtime.js", () => ({ runGuardrails: vi.fn() }));
vi.mock("../../../src/flow/runtime/scope.js", () => ({
  readInput: vi.fn(() => ({ read: ["r"] })),
}));
vi.mock("../../../src/flow/runtime/step-frame.js", () => ({ visitNumberOf: vi.fn(() => 2) }));
vi.mock("../../../src/flow/runtime/soft-stop.js", () => ({ unreadyRoutesOf: vi.fn(() => []) }));
vi.mock("../../../src/flow/runtime/launch/router-decision.js", () => ({
  modelRouterLaunch: vi.fn(),
}));
vi.mock("../../../src/flow/observers/execution-event.js", () => ({ reportNodeEvent: vi.fn() }));

const record = (costUsd: number, caller = "x"): UsageRecord => ({
  ...ZERO_USAGE,
  caller,
  model: "m",
  costUsd: usd(costUsd),
  costSource: CostSource.Api,
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(reportNodeEvent).mockImplementation((work: (base: never) => unknown) =>
    Promise.resolve(work({ base: true } as never)).then(() => undefined),
  );
});

describe("#1366: what a visit's outcome and its code's services record", () => {
  it("the outcome's spend, decisions, tokens and tool calls are copied; what it gave none of is empty", () => {
    const given = {
      usage: [record(0.5)],
      approvals: [{ a: 1 }],
      piiTokens: { t: "1" },
      toolCalls: [{ c: 1 }],
    };
    const out = recordsOf({ read: [], ...given } as never);

    expect(out).toEqual(given);
    expect(out.usage).not.toBe(given.usage);
    expect(recordsOf({ read: [] })).toEqual({
      usage: [],
      approvals: [],
      piiTokens: {},
      toolCalls: [],
    });
  });

  const limits = (remaining: number) => ({ budgets: { remaining: () => remaining } }) as never;
  const node = { id: "n", kind: NodeKind.Agent } as never;

  it("a service's spend is counted at once on the node's path and kept in the order it was reported", () => {
    vi.mocked(countedServiceSpend).mockImplementation(
      (_l: unknown, _n: unknown, _p: unknown, r: UsageRecord) => ({
        ...r,
        counted: true,
      }),
    );
    const { reported, services } = reportingOf(limits(5), node, ["a"]);

    services.reportUsage?.(record(0.25, "one"));
    services.reportUsage?.(record(0.125, "two"));

    expect(reported.usage.map((u) => u.caller)).toEqual(["one", "two"]);
    expect(reported.usage.every((u) => (u as { counted?: boolean }).counted === true)).toBe(true);
    expect(vi.mocked(countedServiceSpend).mock.calls[0]?.slice(0, 3)).toEqual([
      expect.anything(),
      node,
      ["a"],
    ]);
  });

  it("a visit starts with nothing reported; children, tokens and undo entries are collected as they come", () => {
    const { reported, services } = reportingOf(limits(5), node, []);

    expect(reported).toEqual({ usage: [], children: [], piiTokens: {}, compensations: [] });
    services.recordChild?.({ child: 1 } as never);
    services.keepPiiTokens?.({ a: "1" });
    services.keepPiiTokens?.({ b: "2" });
    services.keepCompensations?.(["e1"] as never);
    services.keepCompensations?.(["e2"] as never);

    expect(reported.children).toEqual([{ child: 1 }]);
    expect(reported.piiTokens).toEqual({ a: "1", b: "2" });
    expect(reported.compensations).toEqual(["e1", "e2"]);
  });

  it("the budget left is told to the code, none when the budget has no end", () => {
    const finite = reportingOf(limits(3.5), node, []).services;
    const endless = reportingOf(limits(Infinity), node, []).services;

    expect(finite.remainingBudget?.()).toBe(3.5);
    expect(endless.remainingBudget?.()).toBeUndefined();
  });
});

describe("#1366: the lost passes a step records", () => {
  const lost = { rootExecutionId: "root", checkpointId: "cp", tokens: [1, 2], settledTaskIds: [] };
  const configOf = (changes: Record<string, unknown> = {}) => ({
    configurable: {
      [LOST_PASSES_KEY]: lost,
      __pregel_task_id: "task-1",
      checkpoint_map: { "": "cp" },
      ...changes,
    },
  });
  const siteOf = (changes: Record<string, unknown> = {}) => {
    const reportUsage = vi.fn();
    const recorded = vi.fn();
    const site = {
      node: { id: "n", kind: NodeKind.Agent },
      nodeId: "n#2",
      config: configOf(),
      runId: "run-1",
      services: { reportUsage },
      deps: { observer: { unknownCosts: { recorded } }, workflow: { name: "wf" } },
      ...changes,
    };
    return { site: site as never, reportUsage, recorded };
  };

  it("one record of unknown cost per lost pass, from the step's caller, under the lost pass's own id", () => {
    const { site, reportUsage, recorded } = siteOf();

    recordLostPasses(site);

    expect(reportUsage).toHaveBeenCalledTimes(2);
    expect(reportUsage.mock.calls[0]?.[0]).toMatchObject({
      caller: "agent:n#2",
      model: "unknown",
      costUsd: usd(0),
      costSource: CostSource.Unknown,
      ledgerKey: { id: "unknown:root:n#2:task-1:1" },
    });
    expect(reportUsage.mock.calls[1]?.[0].ledgerKey.id).toBe("unknown:root:n#2:task-1:2");
    expect(recorded).toHaveBeenCalledWith("wf", 2);
  });

  it("a step that calls no model, or whose task no lost pass concerns, records none", () => {
    const action = siteOf({ node: { id: "n", kind: NodeKind.Action } });
    const noLost = siteOf({ config: {} });
    const noServices = siteOf({ services: undefined });

    recordLostPasses(action.site);
    recordLostPasses(noLost.site);
    recordLostPasses(noServices.site);

    expect(action.reportUsage).not.toHaveBeenCalled();
    expect(noLost.reportUsage).not.toHaveBeenCalled();
    expect(noServices.recorded).not.toHaveBeenCalled();
  });

  it("an instance with no tally of unknown costs records them all the same", () => {
    const { site, reportUsage } = siteOf({
      deps: { observer: undefined, workflow: { name: "wf" } },
    });

    recordLostPasses(site);

    expect(reportUsage).toHaveBeenCalledTimes(2);
  });

  it("a branch's lost passes are counted at once on its node's path and kept with its services", () => {
    vi.mocked(countedServiceSpend).mockImplementation(
      (_l: unknown, _n: unknown, _p: unknown, r: UsageRecord) => ({
        ...r,
        counted: true,
      }),
    );
    const services: UsageRecord[] = [];
    const run = {
      node: { id: "n", kind: NodeKind.Agent },
      ticket: { nodeId: "n#2" },
      config: configOf(),
      state: { runId: "run-1", path: ["a"] },
      deps: { limits: "limits", observer: undefined, workflow: { name: "wf" } },
      services,
    };

    recordBranchLostPasses(run as never);

    expect(services).toHaveLength(2);
    expect(services.every((u) => (u as { counted?: boolean }).counted === true)).toBe(true);
    expect(services[0]?.caller).toBe("agent:n#2");
    expect(vi.mocked(countedServiceSpend).mock.calls[0]?.slice(0, 3)).toEqual([
      "limits",
      run.node,
      ["a"],
    ]);
  });
});

describe("#1366: which passes were lost, and which step records them", () => {
  const rows = [
    { kind: "takeover", checkpointId: "cp", previousToken: 3 },
    { kind: "takeover", checkpointId: "cp", previousToken: 1 },
    { kind: "takeover", checkpointId: "cp", previousToken: 3 },
    { kind: "takeover", checkpointId: "other", previousToken: 9 },
    { kind: "yield", checkpointId: "cp", previousToken: 8 },
    { kind: "takeover", checkpointId: "cp" },
  ];

  it("are the holders of the takeovers at the checkpoint, each once, in the order of their tokens", () => {
    expect(lostPassesOf("root", "cp", rows, ["t1", "t2", "t1"])).toEqual({
      rootExecutionId: "root",
      checkpointId: "cp",
      tokens: [1, 3],
      settledTaskIds: ["t1", "t2"],
    });
  });

  it("are none without a checkpoint, and none where no takeover named a token", () => {
    expect(lostPassesOf("root", undefined, rows, [])).toBeUndefined();
    expect(
      lostPassesOf("root", undefined, [{ kind: "takeover", previousToken: 5 }], []),
    ).toBeUndefined();
    expect(lostPassesOf("root", "elsewhere", rows, [])).toBeUndefined();
    expect(
      lostPassesOf("root", "cp", [{ kind: "takeover", checkpointId: "cp" }], []),
    ).toBeUndefined();
  });

  const lost = {
    rootExecutionId: "root",
    checkpointId: "cp",
    tokens: [1],
    settledTaskIds: ["done"],
  };
  const configOf = (changes: Record<string, unknown> = {}) => ({
    configurable: {
      [LOST_PASSES_KEY]: lost,
      __pregel_task_id: "task-1",
      checkpoint_map: { "": "cp" },
      ...changes,
    },
  });

  it("a task of the root graph that no lost pass finished is handed them, with its id", () => {
    expect(lostTokensOfTask(configOf())).toEqual({ taskId: "task-1", lost });
  });

  it.each([
    ["a task a lost pass finished", configOf({ __pregel_task_id: "done" }), "done"],
    ["a task of a child's graph", configOf({ checkpoint_map: { "": "cp", child: "x" } }), "task-1"],
    ["a task from another checkpoint", configOf({ checkpoint_map: { "": "elsewhere" } }), "task-1"],
    ["a map of another namespace", configOf({ checkpoint_map: { child: "cp" } }), "task-1"],
  ])("%s has no lost passes to record", (_name, config, taskId) => {
    expect(lostTokensOfTask(config)).toEqual({ taskId, lost: undefined });
  });

  it.each([
    ["no config", undefined],
    ["no lost passes", configOf({ [LOST_PASSES_KEY]: undefined })],
    ["lost passes that are no object", configOf({ [LOST_PASSES_KEY]: "lost" })],
    ["a null", configOf({ [LOST_PASSES_KEY]: null })],
    ["a root id that is no text", configOf({ [LOST_PASSES_KEY]: { ...lost, rootExecutionId: 1 } })],
    ["a checkpoint that is no text", configOf({ [LOST_PASSES_KEY]: { ...lost, checkpointId: 1 } })],
    ["tokens that are no list", configOf({ [LOST_PASSES_KEY]: { ...lost, tokens: "1" } })],
    ["a token that is no integer", configOf({ [LOST_PASSES_KEY]: { ...lost, tokens: [1, 1.5] } })],
    [
      "settled tasks that are no list",
      configOf({ [LOST_PASSES_KEY]: { ...lost, settledTaskIds: "x" } }),
    ],
    ["no task id", configOf({ __pregel_task_id: undefined })],
    ["no checkpoint map", configOf({ checkpoint_map: undefined })],
    ["a null checkpoint map", configOf({ checkpoint_map: null })],
  ])("%s is no lost pass", (_name, config) => {
    expect(lostTokensOfTask(config)).toEqual({ taskId: "", lost: undefined });
  });

  const siteOf = (node: object) => {
    const reportUsage = vi.fn();
    return {
      reportUsage,
      site: {
        node,
        nodeId: "n",
        config: configOf(),
        runId: "run-1",
        services: { reportUsage },
        deps: { observer: {}, workflow: { name: "wf" } },
      } as never,
    };
  };

  it("a router that a model decides records them, one that a class decides, and a step of code, do not", () => {
    const model = siteOf({
      kind: NodeKind.Router,
      declaration: { kind: NodeKind.Router, options: { decidedBy: "model" } },
    });
    const code = siteOf({
      kind: NodeKind.Router,
      declaration: { kind: NodeKind.Router, options: { decidedBy: "code" } },
    });

    recordLostPasses(model.site);
    recordLostPasses(code.site);

    expect(model.reportUsage).toHaveBeenCalledOnce();
    expect(model.reportUsage.mock.calls[0]?.[0].caller).toBe("router:n");
    expect(code.reportUsage).not.toHaveBeenCalled();
  });
});

describe("#1366: the cost a child's record and a turn report", () => {
  const identity = {
    executionId: "child-1",
    parentExecutionId: "parent",
    rootExecutionId: "root",
    inheritedUsage: 1,
  };
  const child: EndedChild = {
    identity,
    depth: 2,
    workflow: { name: "wf", version: "1", startedVersion: "1", configHash: "h" },
    launchedBy: { nodeId: "n", visitNumber: 1 },
    start: "start",
    input: { i: 1 },
    records: { components: new Map(), graph: { nodes: new Map() } },
  };

  it("a child that failed: its spend is the usage it ended with, its error recorded, no finish", () => {
    const out = childRecordOf(child, undefined, {
      status: ChildExecutionStatus.Failed,
      usage: [record(0.5, "agent:a"), record(0.25, "agent:b")],
      error: new Error("broke"),
    });

    expect(out).toMatchObject({
      executionId: "child-1",
      parentExecutionId: "parent",
      rootExecutionId: "root",
      depth: 2,
      status: ChildExecutionStatus.Failed,
      spend: { totalUsd: usd(0.75), calls: 2 },
      error: { message: "broke" },
      path: [],
      children: [],
    });
    expect("finish" in out).toBe(false);
    expect("itemIndex" in out).toBe(false);
  });

  it("a child of an item names it; a child that finished has its finish and output; one that did not fail has no error", () => {
    const state = {
      finish: "end",
      output: { o: 1 },
      usage: [],
      path: ["p"],
      toolCalls: [],
      stepRecords: [],
      children: [],
    };
    const out = childRecordOf(
      { ...child, identity: { ...identity, itemIndex: 3 } },
      state as never,
      {
        status: ChildExecutionStatus.Finished,
        usage: [],
      },
    );

    expect(out).toMatchObject({
      itemIndex: 3,
      output: { o: 1 },
      spend: { totalUsd: usd(0) },
      path: ["p"],
    });
    expect("finish" in out).toBe(true);
    expect("error" in out).toBe(false);
  });

  it("a child that ended as finished with no state to read has no finish to record", () => {
    const out = childRecordOf(child, undefined, {
      status: ChildExecutionStatus.Finished,
      usage: [],
    });

    expect("finish" in out).toBe(false);
    expect("output" in out).toBe(false);
  });

  it("a child that failed with a state has no finish though its state has one", () => {
    const state = {
      finish: "end",
      output: { o: 1 },
      usage: [],
      path: [],
      toolCalls: [],
      stepRecords: [],
      children: [],
    };
    const out = childRecordOf(child, state as never, {
      status: ChildExecutionStatus.Failed,
      usage: [],
    });

    expect("finish" in out).toBe(false);
    expect("output" in out).toBe(false);
  });

  it("the record of a turn that is running carries the cost so far; a failed one the cost of what it spent", () => {
    expect(runningOutcome(["a", "b"], usd(0.5))).toEqual({
      replyWith: "",
      status: "running",
      stopReason: "",
      route: ["a", "b"],
      steps: [],
      costUsd: usd(0.5),
    });
    expect(failedOutcome(new Error("it broke"), [record(0.5), record(0.25)])).toEqual({
      replyWith: "",
      status: "failed",
      stopReason: "it broke",
      route: [],
      steps: [],
      costUsd: usd(0.75),
    });
  });

  it("a paused loop's spend is what it added to the usage it was handed", () => {
    const state = {
      usage: [record(1, "handed"), record(0.5, "own"), record(0.25, "own")],
      from: { usage: 1 },
    };

    expect(loopOf(state as never).usage.map((u) => u.caller)).toEqual(["own", "own"]);
  });
});

describe("#1366: what a router's visit spends", () => {
  const counted = (r: UsageRecord): UsageRecord => ({ ...r, counted: true }) as UsageRecord;

  function setup(
    options: {
      launches?: number;
      guardrails?: unknown[];
      observer?: object;
    } = {},
  ) {
    const budgets = {
      tally: vi.fn((records: readonly UsageRecord[], _path?: readonly string[]) =>
        records.map(counted),
      ),
      check: vi.fn(),
    };
    const route = vi.fn(() =>
      Promise.resolve({
        kind: "decided",
        decision: { next: "yes", reason: "because" },
        usage: record(0.5, "router"),
      }),
    );
    const deps = {
      pii: undefined,
      guardrails:
        options.guardrails === undefined ? undefined : { inputOf: () => options.guardrails },
      graph: {},
      observer: options.observer,
      launchDecisionFor: vi.fn(() => "decider"),
    };
    const node = {
      id: "r",
      exits: { launches: new Map(options.launches === undefined ? [] : [["x", 1]]) },
    };
    const router = { routes: [{ option: "yes", condition: "when yes" }], instructions: "choose" };
    const run = routerRunner(
      node as never,
      router as never,
      { route } as never,
      deps as never,
      budgets as never,
    );
    return { run, budgets, route, deps };
  }
  const state = { path: ["a"], usage: [record(1, "before")], piiTokens: {} } as never;

  it("the decision's call is counted at once on the router's path, checked against the spend before it, and is the visit's spend", async () => {
    const { run, budgets } = setup();

    const out = await run(state, undefined);

    expect(budgets.tally).toHaveBeenCalledWith([record(0.5, "router")], ["a", "r"]);
    expect(budgets.check).toHaveBeenCalledWith(
      [record(1, "before")],
      ["a", "r"],
      [counted(record(0.5, "router"))],
    );
    expect(out).toMatchObject({
      route: "yes",
      read: ["r"],
      usage: [counted(record(0.5, "router"))],
    });
  });

  it("the masking and the guardrails are counted at once too, and come before the decision", async () => {
    const { run, budgets } = setup({ guardrails: ["g"] });
    vi.mocked(boundaryInputOf).mockReturnValue({
      input: "the input",
      pii: { values: [], key: null, tokens: {} },
    });
    vi.mocked(runGuardrails).mockResolvedValue({
      usage: [record(0.125, "guardrail")],
      decisions: ["d1"],
    } as never);

    const out = await run(state, undefined);

    expect(vi.mocked(runGuardrails).mock.calls[0]?.[1]).toMatchObject({
      text: "the input",
      element: "r",
    });
    expect(budgets.tally.mock.calls.map((c) => c[0].map((u) => u.caller))).toEqual([
      [],
      ["guardrail"],
      ["router"],
    ]);
    expect(out.usage?.map((u) => u.caller)).toEqual(["guardrail", "router"]);
    expect(out.guardrailDecisions).toEqual(["d1"]);
  });

  it("a router that reads through PII policies has the masking's spend counted, and is read masked", async () => {
    const budgets = {
      tally: vi.fn((records: readonly UsageRecord[], _path?: readonly string[]) =>
        records.map(counted),
      ),
      check: vi.fn(),
    };
    const set = { withValues: () => ({ withFieldKey: () => "set" }) };
    const deps = {
      pii: { policiesOf: () => set },
      guardrails: undefined,
      graph: {},
      observer: undefined,
    };
    vi.mocked(maskedModelText).mockResolvedValue({
      text: "masked",
      tokens: { t: "1" },
      usage: [record(0.0625, "masking")],
    });
    const route = vi.fn((_request: unknown) =>
      Promise.resolve({ kind: "decided", decision: { next: "yes", reason: "" }, usage: undefined }),
    );
    const run = routerRunner(
      { id: "r", exits: { launches: new Map() } } as never,
      { routes: [], instructions: "" } as never,
      { route } as never,
      deps as never,
      budgets as never,
    );

    const out = await run(state, undefined);

    expect(out.usage?.map((u) => u.caller)).toEqual(["masking"]);
    expect(out.piiTokens).toEqual({ t: "1" });
    expect(route.mock.calls[0]?.[0]).toMatchObject({ input: "masked" });
  });

  it("a decision that reported no spend adds none", async () => {
    const { run, route } = setup();
    route.mockResolvedValue({
      kind: "decided",
      decision: { next: "yes", reason: "" },
      usage: undefined,
    } as never);

    const out = await run(state, undefined);

    expect(out.usage).toEqual([]);
  });

  it("a failed decision fails the step with the masking's and the guardrails' spend and the call's, counted", async () => {
    const { run, route, budgets } = setup({ guardrails: ["g"] });
    vi.mocked(runGuardrails).mockResolvedValue({
      usage: [record(0.125, "guardrail")],
      decisions: [],
    });
    route.mockResolvedValue({
      kind: "failed",
      reason: "no answer",
      cause: new Error("model down"),
      usage: record(0.5, "router"),
    } as never);

    const failure = await run(state, undefined).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(RouterFailedError);
    expect((failure as RouterFailedError).usage.map((u) => u.caller)).toEqual([
      "guardrail",
      "router",
    ]);
    expect(
      (failure as RouterFailedError).usage.every(
        (u) => (u as { counted?: boolean }).counted === true,
      ),
    ).toBe(true);
    expect(budgets.check).toHaveBeenCalledTimes(3);
  });

  it("a failed decision with no spend of its own and no cause is a decision error that carries what came before", async () => {
    const { run, route } = setup();
    route.mockResolvedValue({ kind: "failed", reason: "not a route" } as never);

    const failure = await run(state, undefined).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(RouterDecisionError);
    expect((failure as RouterDecisionError).usage).toEqual([]);
    expect(failure).toMatchObject({ nodeId: "r", visitNumber: 2 });
  });

  it("a router that launches decides its routes in one call, its spend counted and the visit's", async () => {
    const { run, deps } = setup({ launches: 1 });
    vi.mocked(modelRouterLaunch).mockResolvedValue({
      launch: ["a", "b"],
      reason: "both",
      usage: [record(0.5, "launch")],
    });

    const out = await run(state, { signal: undefined } as never);

    expect(out).toMatchObject({ launch: ["a", "b"], read: ["r"] });
    expect(out.usage?.map((u) => u.caller)).toEqual(["launch"]);
    expect((out.usage?.[0] as { counted?: boolean }).counted).toBe(true);
    expect(deps.launchDecisionFor).toHaveBeenCalledOnce();
    expect(vi.mocked(modelRouterLaunch).mock.calls[0]?.[0]).toMatchObject({
      input: "the input",
      decider: "decider",
      step: { nodeId: "r", visitNumber: 2 },
    });
  });

  it("the observer hears the router start with its input, and end with its route and reason", async () => {
    const onRouterStart = vi.fn();
    const onRouterEnd = vi.fn();
    const { run } = setup({ observer: { onRouterStart, onRouterEnd } });

    await run(state, undefined);

    expect(onRouterStart).toHaveBeenCalledWith({ base: true, name: "r", input: "the input" });
    expect(onRouterEnd).toHaveBeenCalledWith({
      base: true,
      name: "r",
      output: { route: "yes", reason: "because" },
    });
  });

  it("the observer hears a launching router end with the routes it launched, joined", async () => {
    const onRouterEnd = vi.fn();
    const { run } = setup({ launches: 1, observer: { onRouterStart: vi.fn(), onRouterEnd } });
    vi.mocked(modelRouterLaunch).mockResolvedValue({
      launch: ["a", "b"],
      reason: "both",
      usage: [],
    });

    await run(state, undefined);

    expect(onRouterEnd).toHaveBeenCalledWith({
      base: true,
      name: "r",
      output: { route: "a, b", reason: "both" },
    });
  });
});

describe("#1366: what a router reads, masked, and what the masking costs", () => {
  const counted = (r: UsageRecord): UsageRecord => ({ ...r, counted: true }) as UsageRecord;
  const state = {
    path: ["a"],
    usage: [],
    piiTokens: { s: "state" },
    history: [],
  } as never;

  function setup(options: { memory: string; guardrails?: unknown[]; pii?: boolean }) {
    const budgets = {
      tally: vi.fn((records: readonly UsageRecord[], _path?: readonly string[]) =>
        records.map(counted),
      ),
      check: vi.fn(),
    };
    const route = vi.fn((_request: { input: string }) =>
      Promise.resolve({ kind: "decided", decision: { next: "yes", reason: "" }, usage: undefined }),
    );
    const set = { withValues: () => ({ withFieldKey: () => "set" }) };
    const deps = {
      pii: options.pii === false ? undefined : { policiesOf: () => set },
      guardrails:
        options.guardrails === undefined ? undefined : { inputOf: () => options.guardrails },
      graph: {},
      observer: undefined,
    };
    vi.mocked(formatMemory).mockReturnValue(options.memory);
    vi.mocked(readerMemoryOf).mockReturnValue({
      summaries: ["s1", "s2"],
      history: ["h1"],
    } as never);
    vi.mocked(boundaryInputOf).mockReturnValue({
      input: "the input",
      pii: { values: [], key: null, tokens: { b: "boundary" } },
    });
    vi.mocked(maskedModelText).mockImplementation((_set: unknown, text: string, known: object) =>
      Promise.resolve({
        text: `m(${text})`,
        tokens: { [`t-${text}`]: "x" },
        usage: [record(0.0625, `mask-${text}`)],
        seen: known,
      }),
    );
    vi.mocked(runGuardrails).mockResolvedValue({ usage: [], decisions: [] });
    const run = routerRunner(
      { id: "r", exits: { launches: new Map() } } as never,
      { routes: [], instructions: "" } as never,
      { route } as never,
      deps as never,
      budgets as never,
    );
    return { run, route };
  }

  it("the memory is formatted with how many summaries and turns it holds", async () => {
    const { run } = setup({ memory: "", pii: false });

    await run(state, undefined);

    expect(formatMemory).toHaveBeenCalledWith(
      { summaries: ["s1", "s2"], history: ["h1"] },
      { summaries: 2, turns: 1 },
    );
  });

  it("read as it is, the memory comes first, a blank line before the input; no memory, the input alone", async () => {
    const withMemory = setup({ memory: "mem", pii: false });
    await withMemory.run(state, undefined);
    const none = setup({ memory: "", pii: false });
    await none.run(state, undefined);

    expect(withMemory.route.mock.calls[0]?.[0].input).toBe("mem\n\nthe input");
    expect(none.route.mock.calls[0]?.[0].input).toBe("the input");
  });

  it("masked as one text without guardrails: the whole text under the state's and the boundary's tokens, its spend counted", async () => {
    const { run, route } = setup({ memory: "mem" });

    const out = await run(state, undefined);

    expect(vi.mocked(maskedModelText).mock.calls).toHaveLength(1);
    expect(vi.mocked(maskedModelText).mock.calls[0]?.[1]).toBe("mem\n\nthe input");
    expect(vi.mocked(maskedModelText).mock.calls[0]?.[2]).toEqual({ s: "state", b: "boundary" });
    expect(route.mock.calls[0]?.[0].input).toBe("m(mem\n\nthe input)");
    expect(out.usage?.map((u) => u.caller)).toEqual(["mask-mem\n\nthe input"]);
    expect(runGuardrails).not.toHaveBeenCalled();
    expect(out.guardrailDecisions).toEqual([]);
  });

  it("masked text by text with guardrails: each under what the ones before made, the guardrails read the input alone", async () => {
    const { run, route } = setup({ memory: "mem", guardrails: ["g"] });

    const out = await run(state, undefined);

    expect(vi.mocked(maskedModelText).mock.calls.map((c) => c[1])).toEqual(["mem", "the input"]);
    expect(vi.mocked(maskedModelText).mock.calls[0]?.[2]).toEqual({ s: "state", b: "boundary" });
    expect(vi.mocked(maskedModelText).mock.calls[1]?.[2]).toEqual({
      s: "state",
      b: "boundary",
      "t-mem": "x",
    });
    expect(route.mock.calls[0]?.[0].input).toBe("m(mem)\n\nm(the input)");
    expect(vi.mocked(runGuardrails).mock.calls[0]?.[1]).toMatchObject({ text: "m(the input)" });
    expect(out.piiTokens).toEqual({ b: "boundary", "t-mem": "x", "t-the input": "x" });
    expect(out.usage?.map((u) => u.caller)).toEqual(["mask-mem", "mask-the input"]);
  });

  it("with guardrails and no memory the input is the only text", async () => {
    const { run } = setup({ memory: "", guardrails: ["g"] });

    await run(state, undefined);

    expect(vi.mocked(maskedModelText).mock.calls.map((c) => c[1])).toEqual(["the input"]);
    expect(vi.mocked(runGuardrails).mock.calls[0]?.[1]).toMatchObject({ text: "m(the input)" });
  });

  it("a router with no guardrail listed has none to run, whatever the application lists", async () => {
    const { run } = setup({ memory: "", guardrails: [] });

    await run(state, undefined);

    expect(runGuardrails).not.toHaveBeenCalled();
  });

  it("a launching router without a decider of its own asks for none", async () => {
    const budgets = { tally: vi.fn((r: readonly UsageRecord[]) => r), check: vi.fn() };
    const config = { signal: undefined };
    vi.mocked(boundaryInputOf).mockReturnValue({
      input: "the input",
      pii: { values: [], key: null, tokens: {} },
    });
    vi.mocked(modelRouterLaunch).mockResolvedValue({
      launch: ["a"],
      reason: "",
      usage: [],
    });
    const run = routerRunner(
      { id: "r", exits: { launches: new Map([["x", 1]]) } } as never,
      { routes: [], instructions: "" } as never,
      { route: vi.fn() } as never,
      { pii: undefined, guardrails: undefined, graph: {}, observer: undefined } as never,
      budgets as never,
    );

    await run(state, config as never);

    expect(vi.mocked(modelRouterLaunch).mock.calls[0]?.[0]).toMatchObject({
      decider: undefined,
      config,
    });
  });
});
