/**
 * #1366 (budget-flow shard) — what a branch of a launch watches of the budgets, each rule on its own over fakes:
 * the pass's `exhausted` signal stops the branch's step and its calls — unless a budget was exhausted before the
 * branch started, when its steps stop at their own check —, a service's spend the branch reports is counted at
 * once, and the branch's own signal is the execution's and the launch's.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CostSource, ZERO_USAGE, type UsageRecord } from "../../../src/finops/usage.js";
import { countedServiceSpend } from "../../../src/flow/runtime/limits.js";
import { branchFrameOf } from "../../../src/flow/runtime/launch/branch-view.js";
import { readInput } from "../../../src/flow/runtime/scope.js";
import { stepFrameAt } from "../../../src/flow/runtime/step-frame.js";

vi.mock("../../../src/flow/runtime/step-frame.js", () => ({ stepFrameAt: vi.fn() }));
vi.mock("../../../src/flow/runtime/limits.js", () => ({ countedServiceSpend: vi.fn() }));
vi.mock("../../../src/flow/runtime/scope.js", () => ({
  readInput: vi.fn(() => ({ fields: { read: true } })),
}));

const record = (costUsd: number, caller = "service"): UsageRecord => ({
  ...ZERO_USAGE,
  caller,
  model: "m",
  costUsd,
  costSource: CostSource.Api,
});

function setup(options: { isExhausted?: boolean } = {}) {
  const exhausted = new AbortController();
  if (options.isExhausted === true) exhausted.abort();
  const execution = new AbortController();
  const live = { controller: new AbortController() };
  const limits = { budgets: { exhausted: exhausted.signal } };
  vi.mocked(stepFrameAt).mockImplementation(
    () => ({ execution: { signal: execution.signal, id: "e1" }, step: { step: true } }) as never,
  );
  const run = {
    node: { id: "n" },
    state: { runId: "run-1", path: ["a"] },
    config: undefined,
    ticket: { visitNumber: 2, nodeId: "n", copyNumber: 1, itemIndex: undefined },
    live,
    deps: { limits, graph: { graph: true } },
    services: [] as UsageRecord[],
    children: [],
    piiTokens: {},
    compensations: [],
  };
  return { run: run as never, plain: run, exhausted, execution, live, limits };
}

const view = { path: ["a", "b"] } as never;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(stepFrameAt).mockReset();
});

describe("#1366: the exhausted signal a branch watches", () => {
  it("is the pass's: its abort stops the step's signal, and the branch carries it for its own failure", () => {
    const { run, exhausted, execution } = setup();

    const out = branchFrameOf(run, view);

    expect(out.budgetStop).toBe(exhausted.signal);
    const signal = out.frame.execution.signal;
    expect(signal.aborted).toBe(false);
    exhausted.abort();
    expect(signal.aborted).toBe(true);
  });

  it("the step's own signal still stops it: the execution's cancel", () => {
    const { run, execution } = setup();

    const out = branchFrameOf(run, view);
    execution.abort();

    expect(out.frame.execution.signal.aborted).toBe(true);
  });

  it("a budget exhausted before the branch started is not watched: its steps stop at their own check", () => {
    const { run, execution } = setup({ isExhausted: true });

    const out = branchFrameOf(run, view);

    expect(Object.keys(out)).not.toContain("budgetStop");
    expect(out.frame.execution.signal).toBe(execution.signal);
  });

  it("the step's frame keeps what it was made with when the stop is added", () => {
    const { run } = setup();

    const out = branchFrameOf(run, view);

    expect(out.frame.execution).toMatchObject({ id: "e1" });
    expect(Object.isFrozen(out.frame.execution)).toBe(true);
    expect(out.frame.step).toEqual({ step: true });
  });
});

describe("#1366: the branch's own signal and the spend it reports", () => {
  it("its config's signal is the execution's and the launch's", () => {
    const { run, live } = setup();

    const out = branchFrameOf(run, view);

    expect(out.signal.aborted).toBe(false);
    live.controller.abort();
    expect(out.signal.aborted).toBe(true);
    expect(out.config.signal).toBe(out.signal);
  });

  it("a service's usage is counted at once under the node on the view's path, and is the branch's spend", () => {
    const { run, plain, limits } = setup();
    vi.mocked(countedServiceSpend).mockImplementation(
      (_l, _n, _p, spent) => ({ ...spent, counted: true }) as never,
    );

    const out = branchFrameOf(run, view);
    out.frame.services?.reportUsage?.(record(0.25));

    expect(countedServiceSpend).toHaveBeenCalledWith(limits, plain.node, ["a", "b"], record(0.25));
    expect(plain.services).toEqual([{ ...record(0.25), counted: true }]);
  });

  it("a branch that is no item of a list has no item index on its step", () => {
    const { run } = setup();

    branchFrameOf(run, view);

    expect(Object.keys(vi.mocked(stepFrameAt).mock.calls[0]?.[0] ?? {})).not.toContain("itemIndex");
  });

  it("what its code reports — ended children, PII tokens, undone entries — is the branch's, and its input is read on its view", () => {
    const { run, plain } = setup();
    const services = branchFrameOf(run, view).frame.services ?? {};

    services.recordChild?.({ child: 1 } as never);
    services.keepPiiTokens?.({ a: "1" });
    services.keepPiiTokens?.({ b: "2" });
    services.keepCompensations?.(["e1"] as never);
    services.keepCompensations?.(["e2"] as never);
    const input = services.input?.();

    expect(plain.children).toEqual([{ child: 1 }]);
    expect(plain.piiTokens).toEqual({ a: "1", b: "2" });
    expect(plain.compensations).toEqual(["e1", "e2"]);
    expect(input).toEqual({ read: true });
    expect(readInput).toHaveBeenCalledWith({ graph: true }, plain.node, view);
  });

  it("the step is made at the branch's visit, copy and item", () => {
    const { run, plain } = setup();
    Object.assign(plain.ticket, { itemIndex: 3, copyNumber: 2 });

    branchFrameOf(run, view);

    expect(vi.mocked(stepFrameAt).mock.calls[0]?.[0]).toEqual({
      node: plain.node,
      visitNumber: 2,
      nodeId: "n",
      copyNumber: 2,
      itemIndex: 3,
    });
  });
});
