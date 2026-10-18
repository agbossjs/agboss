/** #261 PR 5: an execution's budgets at the run layer — opened before the first call, counted after each. */
import { describe, expect, it } from "vitest";
import { BudgetScope } from "../src/budgets/budget.js";
import { BudgetExceededError } from "../src/graph/limits.js";
import {
  routeTo,
  fakeDeps,
  memoryLedger,
  recordingRouters,
  runText,
  usageRecord,
  type RecordingCostLedger,
} from "./helpers.js";

/** The tenant `default` already spent `amount` today (of the test tenant budget's $1000). */
async function spentToday(ledger: RecordingCostLedger, amount: number): Promise<void> {
  const counter = {
    budget: "test-tenant-daily-budget",
    scope: BudgetScope.Tenant,
    key: "default",
    period: new Date().toISOString().slice(0, 10),
  };
  await ledger.saveAll([counter], [usageRecord("earlier", amount)]);
  ledger.recorded.length = 0;
}

describe("an execution's budgets", () => {
  it("refuses to run without a single call when the tenant's day is spent", async () => {
    const ledger = memoryLedger();
    await spentToday(ledger, 1000);
    const { deps, requests } = recordingRouters(await fakeDeps({}, { ledger }));

    const failure = runText("Anything", deps);

    await expect(failure).rejects.toBeInstanceOf(BudgetExceededError);
    await expect(failure).rejects.toMatchObject({
      budget: { name: "test-tenant-daily-budget" },
      key: "default",
      maxSpend: 1000,
      spent: 1000,
    });
    expect(requests).toEqual([]);
  });

  it("may spend its execution budget while the day is young", async () => {
    const ledger = memoryLedger();
    await spentToday(ledger, 0.5);
    const deps = await fakeDeps(
      { "test/router": [routeTo("alpha-agent")], "test/alpha": ["42"] },
      { ledger },
    );

    expect((await runText("Anything", deps)).budgetUsd).toBe(1);
  });

  it("may spend what is left of the day; every call is counted", async () => {
    const ledger = memoryLedger();
    await spentToday(ledger, 999.75);
    const deps = await fakeDeps(
      { "test/router": [routeTo("alpha-agent")], "test/alpha": ["42"] },
      { ledger },
    );

    const result = await runText("Anything", deps);

    expect(result.budgetUsd).toBeCloseTo(0.25);
    expect(ledger.recorded.map((record) => record.caller)).toEqual([
      "router:main-router",
      "alpha-agent",
    ]);
  });
});
