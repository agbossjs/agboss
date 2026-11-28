/**
 * #1356 (spend shard) — the cost report of a turn, rule by rule with exact amounts (every price a power of two, so each
 * sum is exact): the known total and the calls that made it, the lost passes counted apart, the tokens of the known
 * calls only, the sums by caller, category, model and provider (a charge of no provider is in none), the trace as the
 * calls happened with no ledger mark on a line, the report of reports, and what is left of a budget.
 */
import { describe, expect, it } from "vitest";
import { StepError } from "../../src/core/error-families/step-errors.js";
import {
  CostCategory,
  CostReport,
  CostSource,
  NO_PROVIDER,
  tokensOf,
  totalCost,
  totalTokens,
  type UsageRecord,
} from "../../src/finops/usage.js";
import {
  budgetLeftAfter,
  budgetLeftOf,
  isBudgetLeftUsed,
  storedUsd,
} from "../../src/finops/cost-report.js";
import { LedgerState } from "../../src/finops/ledger-mark.js";
import { usd } from "../../src/units/index.js";

const call = (
  changes: Partial<UsageRecord> & Pick<UsageRecord, "caller" | "costUsd">,
): UsageRecord => ({
  model: "m1",
  provider: "p1",
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costSource: CostSource.Api,
  ...changes,
});

const first = call({
  caller: "alpha-agent",
  costUsd: usd(0.5),
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 10,
  cacheWriteTokens: 5,
  servedBy: "Fireworks",
  ledger: { state: LedgerState.Written, ledgerId: "p:1", madeAt: new Date("2026-11-04T12:00:00Z") },
});
const second = call({
  caller: "alpha-agent",
  costUsd: usd(0.25),
  model: "m2",
  provider: "p2",
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 1,
  cacheWriteTokens: 2,
});
const routing = call({
  caller: "router:main",
  costUsd: usd(0.125),
  provider: NO_PROVIDER,
  inputTokens: 1,
  outputTokens: 2,
});
const tool = call({
  caller: "tool:search",
  costUsd: usd(0.0625),
  provider: NO_PROVIDER,
  model: "none",
});
const review = call({
  caller: "judge:quality",
  costUsd: usd(0.03125),
  provider: "p1",
  model: "m2",
});
const lost = call({
  caller: "alpha-agent",
  costUsd: usd(0),
  costSource: CostSource.Unknown,
  inputTokens: 7,
  outputTokens: 11,
  cacheReadTokens: 13,
  cacheWriteTokens: 17,
});
const turn = [first, second, routing, tool, review, lost];

describe("#1356: the report of a turn", () => {
  const report = CostReport.fromUsage(turn);

  it("the known total, the calls that made it and the lost passes apart", () => {
    expect(report.totalUsd).toBe(0.96875);
    expect(report.calls).toBe(5);
    expect(report.unknownCalls).toBe(1);
  });

  it("the tokens of the known calls only: a lost pass has none, the cache's are inside the input", () => {
    expect(report.inputTokens).toBe(111);
    expect(report.outputTokens).toBe(57);
    expect(report.cacheReadTokens).toBe(11);
    expect(report.cacheWriteTokens).toBe(7);
    expect(report.totalTokens).toBe(168);
  });

  it("the sums by caller, model and provider are of the known calls, a charge of no provider is in no provider's", () => {
    expect(report.byCaller).toStrictEqual({
      "alpha-agent": usd(0.75),
      "router:main": usd(0.125),
      "tool:search": usd(0.0625),
      "judge:quality": usd(0.03125),
    });
    expect(report.byModel).toStrictEqual({ m1: usd(0.625), m2: usd(0.28125), none: usd(0.0625) });
    expect(report.byProvider).toStrictEqual({ p1: usd(0.53125), p2: usd(0.25) });
  });

  it("every category is present, each with what its callers cost", () => {
    expect(report.byCategory).toStrictEqual({
      [CostCategory.Agents]: usd(0.75),
      [CostCategory.Routing]: usd(0.125),
      [CostCategory.Guardrails]: usd(0),
      [CostCategory.Review]: usd(0.03125),
      [CostCategory.Tools]: usd(0.0625),
      [CostCategory.Memory]: usd(0),
      [CostCategory.Rag]: usd(0),
      [CostCategory.Files]: usd(0),
      [CostCategory.Pii]: usd(0),
      [CostCategory.Arbiters]: usd(0),
      [CostCategory.Pauses]: usd(0),
    });
  });

  it("the trace is every call in the order it happened with its category, and no mark of the ledger on a line", () => {
    expect(report.trace.map((line) => [line.caller, line.category, line.costUsd])).toEqual([
      ["alpha-agent", CostCategory.Agents, 0.5],
      ["alpha-agent", CostCategory.Agents, 0.25],
      ["router:main", CostCategory.Routing, 0.125],
      ["tool:search", CostCategory.Tools, 0.0625],
      ["judge:quality", CostCategory.Review, 0.03125],
      ["alpha-agent", CostCategory.Agents, 0],
    ]);
    expect(report.trace[0]).toStrictEqual({
      caller: "alpha-agent",
      category: CostCategory.Agents,
      model: "m1",
      provider: "p1",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      costUsd: 0.5,
      costSource: CostSource.Api,
      servedBy: "Fireworks",
    });
    expect(report.trace[5]?.costSource).toBe(CostSource.Unknown);
  });

  it("an empty turn reports nothing, in every field", () => {
    const empty = CostReport.empty();

    expect(empty).toStrictEqual(CostReport.fromUsage([]));
    expect(empty.totalUsd).toBe(0);
    expect([empty.calls, empty.unknownCalls, empty.totalTokens]).toEqual([0, 0, 0]);
    expect(empty.byCaller).toStrictEqual({});
    expect(Object.values(empty.byCategory)).toEqual(Array(11).fill(0));
    expect(empty.trace).toEqual([]);
  });
});

describe("#1356: the report of reports", () => {
  it("is the report of every call of them in order, a call's host and provider kept", () => {
    const one = CostReport.fromUsage([first, routing]);
    const other = CostReport.fromUsage([second, tool, review, lost]);

    const together = CostReport.sum([one, other]);

    expect(together).toStrictEqual(
      CostReport.fromUsage([first, routing, second, tool, review, lost]),
    );
    expect(together.trace[0]?.servedBy).toBe("Fireworks");
    expect(Object.keys(together.trace[1] ?? {})).not.toContain("servedBy");
    expect(together.trace.map((line) => line.caller)).toEqual([
      "alpha-agent",
      "router:main",
      "alpha-agent",
      "tool:search",
      "judge:quality",
      "alpha-agent",
    ]);
    expect(CostReport.sum([])).toStrictEqual(CostReport.empty());
  });
});

describe("#1356: sums and what is left of a budget", () => {
  it("the dollars and the tokens of records are the sums of theirs, none for none", () => {
    expect(totalCost([first, second])).toBe(0.75);
    expect(totalCost([])).toBe(0);
    expect(tokensOf({ inputTokens: 3, outputTokens: 4 })).toBe(7);
    expect(totalTokens([first, second, routing])).toBe(168);
    expect(totalTokens([])).toBe(0);
  });

  it("a stored amount is finite and from zero, as dollars; any other is refused", () => {
    expect(storedUsd.parse(0)).toBe(0);
    expect(storedUsd.parse(0.5)).toBe(0.5);
    for (const bad of [-0.5, Number.NaN, Number.POSITIVE_INFINITY, "1", null])
      expect(storedUsd.safeParse(bad).success).toBe(false);
  });

  it("what is left of a budget: none when nothing limits dollars, else an amount that never goes below zero", () => {
    expect(budgetLeftOf(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(budgetLeftOf(2.5)).toBe(2.5);
    expect(budgetLeftOf(-3)).toBe(0);
    expect(budgetLeftAfter(undefined, usd(1))).toBeUndefined();
    expect(budgetLeftAfter(usd(5), usd(2))).toBe(3);
    expect(budgetLeftAfter(usd(1), usd(2))).toBe(0);
  });

  it("a budget is used up at zero, never before, and never without a limit", () => {
    expect(isBudgetLeftUsed(undefined)).toBe(false);
    expect(isBudgetLeftUsed(usd(0))).toBe(true);
    expect(isBudgetLeftUsed(usd(0.0001))).toBe(false);
  });
});

describe("#1356: the spend a paid error carries", () => {
  it("is the report of the usage it carries, as a turn's would be", () => {
    const error = new StepError.Agent({
      agent: "clerk-agent",
      message: "failed",
      usage: [first, second],
      cause: new Error("cut"),
    });

    expect(error.spend).toStrictEqual(CostReport.fromUsage([first, second]));
    expect(error.spend.totalUsd).toBe(0.75);
  });
});
