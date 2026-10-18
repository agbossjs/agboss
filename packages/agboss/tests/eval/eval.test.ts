import { describe, expect, it, vi } from "vitest";
import { evaluate, scoreOf, type EvalDeps } from "../../src/eval/eval.js";
import type { RouteOutcome, RouterEngine } from "../../src/routers/index.js";
import { BUDGET_EXHAUSTED } from "../../src/eval/eval.js";
import { BudgetScope } from "../../src/budgets/budget.js";
import { usd } from "../../src/units/index.js";
import {
  routeTo,
  fakeDeps,
  memoryLedger,
  runText,
  usageRecord,
  type RecordingCostLedger,
} from "../helpers.js";

const judge = (...outcomes: RouteOutcome[]): RouterEngine => {
  const route = vi.fn<RouterEngine["route"]>();
  for (const outcome of outcomes) route.mockResolvedValueOnce(outcome);
  return { name: "judge", route };
};

const adequate = (confidence?: number): RouteOutcome => ({
  kind: "decided",
  decision: { next: "adequate", reason: "r", ...(confidence === undefined ? {} : { confidence }) },
  usage: usageRecord("router:judge", 0.001),
});

async function answeredRuns(count: number, ledger: RecordingCostLedger = memoryLedger()) {
  const script: Record<string, string[]> = { "test/router": [], "test/alpha": [] };
  for (let i = 0; i < count; i += 1) {
    script["test/router"]?.push(routeTo("alpha-agent"));
    script["test/alpha"]?.push(`answer ${String(i)}`);
  }
  const deps = await fakeDeps(script, { ledger });
  for (let i = 0; i < count; i += 1) await runText(`task ${String(i)}`, deps);
  return deps;
}

describe("scoreOf", () => {
  it("is P(adequate)", () => {
    expect(scoreOf(adequate(0.9))).toBe(0.9);
    expect(scoreOf(adequate())).toBe(1);
    expect(
      scoreOf({ kind: "decided", decision: { next: "inadequate", reason: "", confidence: 0.8 } }),
    ).toBeCloseTo(0.2);
    expect(scoreOf({ kind: "failed", reason: "down" })).toBeUndefined();
  });
});

describe("evaluate", () => {
  it("scores unscored answered Terns; the judge's spend counts in the application's budgets", async () => {
    const ledger = memoryLedger();
    const deps = await answeredRuns(2, ledger);
    const evaluation: EvalDeps = {
      terns: deps.terns,
      budgets: deps.budgets,
      judge: judge(adequate(0.9), adequate(0.7)),
    };
    ledger.recorded.length = 0;

    const report = await evaluate(evaluation, "test-bundle-workflow", { limit: 10 });

    expect(report).toEqual({ scored: 2, costUsd: 0.002 });
    expect(ledger.recorded.map((record) => record.caller)).toEqual([
      "router:judge",
      "router:judge",
    ]);
    expect((await deps.terns.summary("test-bundle-workflow"))[0]?.meanScore).toBeCloseTo(0.8);
    expect(await evaluate(evaluation, "test-bundle-workflow", { limit: 10 })).toEqual({
      scored: 0,
      costUsd: 0,
    });
  });

  it("leaves a Tern unscored when the judge fails", async () => {
    const deps = await answeredRuns(1);
    const evaluation: EvalDeps = {
      terns: deps.terns,
      budgets: deps.budgets,
      judge: judge({ kind: "failed", reason: "down" }),
    };

    expect(await evaluate(evaluation, "test-bundle-workflow", { limit: 10 })).toEqual({
      scored: 0,
      costUsd: 0,
    });
    expect(await deps.terns.unscored("test-bundle-workflow", undefined, 10)).toHaveLength(1);
  });

  it("stops when an application budget is spent by its last known limit", async () => {
    const ledger = memoryLedger();
    const deps = await answeredRuns(1, ledger);
    const account = {
      budget: "test-application-daily-budget",
      scope: BudgetScope.Application,
      key: "test-application",
    };
    // the last execution read $0: the day has spent it
    await ledger.saveMaxSpend(account, usd(0));
    const evaluation: EvalDeps = {
      terns: deps.terns,
      budgets: deps.budgets,
      judge: judge(adequate()),
    };

    expect(await evaluate(evaluation, "test-bundle-workflow", { limit: 10 })).toEqual({
      scored: 0,
      costUsd: 0,
      stoppedBy: BUDGET_EXHAUSTED,
    });
  });
});
