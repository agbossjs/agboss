/**
 * #1366: the spend a limit error states — the figure and the records of what the run had spent when it hit the
 * limit, whichever limit it is (the steps', the depth's, a budget's), in its message and on the error, so a
 * handler and the ledger see the same spend.
 */
import { LimitError } from "../../src/core/error-families/limit-errors.js";
import { describe, expect, it } from "vitest";
import { BudgetScope } from "../../src/budgets/budget.js";
import { CostSource, ZERO_USAGE, type UsageRecord } from "../../src/finops/usage.js";
import { usd } from "../../src/units/index.js";

const record = (costUsd: number, caller: string): UsageRecord => ({
  provider: "test-provider",
  ...ZERO_USAGE,
  caller,
  model: "m",
  costUsd: usd(costUsd),
  costSource: CostSource.Api,
});

const workflow = { name: "desk", version: "1.0.0", startedVersion: "1.0.0", configHash: "h" };
const spent = [record(0.25, "agent")];

describe("#1366: the spend of a limit error", () => {
  it("a limit states its spend in its message, as a figure and as records", () => {
    const error = new LimitError.Agent({
      key: "k",
      limit: 1,
      actual: 2,
      path: ["flow", "step"],
      spentUsd: usd(0.25),
      usage: spent,
    });

    expect(error.spentUsd).toBe(0.25);
    expect(error.usage).toEqual(spent);
    expect(error.message).toContain("path: flow → step; spent $0.2500");
  });

  it("a limit with no records has none", () => {
    const error = new LimitError.Agent({
      key: "k",
      limit: 1,
      actual: 2,
      path: [],
      spentUsd: usd(0),
    });

    expect(error.usage).toEqual([]);
  });

  it("a budget carries the run's spend and its records through to the limit", () => {
    const error = new LimitError.Budget({
      budget: { name: "daily" },
      scope: BudgetScope.Application,
      key: "app",
      maxSpend: usd(1),
      spent: usd(1.5),
      path: ["flow"],
      spentUsd: usd(1.5),
      usage: spent,
    });

    expect(error).toMatchObject({ spentUsd: usd(1.5), usage: spent, path: ["flow"] });
  });

  it("a budget without records has none", () => {
    const error = new LimitError.Budget({
      budget: { name: "daily" },
      scope: BudgetScope.Application,
      key: "app",
      maxSpend: usd(1),
      spent: usd(1.5),
      path: ["flow"],
      spentUsd: usd(1.5),
    });

    expect(error.usage).toEqual([]);
  });

  it("the steps' limit carries the figure it was given", () => {
    const error = new LimitError.Steps({
      workflowRecord: workflow,
      maxSteps: 3,
      path: ["flow"],
      spentUsd: usd(0.75),
    });

    expect(error).toMatchObject({ spentUsd: usd(0.75), steps: 4 });
  });

  it("the depth limit has spent nothing: its step never ran", () => {
    const error = new LimitError.Depth({ workflowRecord: workflow, maxDepth: 2, path: ["flow"] });

    expect(error).toMatchObject({ spentUsd: usd(0), depth: 3 });
  });
});
