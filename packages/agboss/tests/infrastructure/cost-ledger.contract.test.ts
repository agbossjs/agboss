/**
 * #265 AC7 / AC8, #261 PR 5: `CostLedgerRepository` — one counter per budget, scope key and period,
 * each call's cost added to every counter it is given; the last `maxSpend()` per budget and scope
 * key; with several instances the counters are shared through the listed implementation. One suite,
 * run against the in-memory default and `SqliteCostLedgerRepository` (two instances on one file).
 */
import { describe, expect, it } from "vitest";
import { BudgetScope } from "../../src/budgets/budget.js";
import type { UsageRecord } from "../../src/finops/usage.js";
import type { CostCounter, CostLedgerRepository } from "../../src/index.js";
import { InMemoryCostLedgerRepository } from "../../src/infrastructure/cost-ledger.repository.js";
import { SqliteCostLedgerRepository } from "../../src/infrastructure/sqlite/sqlite-cost-ledger.repository.js";
import { usd } from "../../src/units/index.js";
import { sharedInMemory, storeKinds } from "./contracts/store-kinds.js";

const kinds = storeKinds<CostLedgerRepository>({
  inMemory: (seam) => sharedInMemory(seam, "ledger", () => new InMemoryCostLedgerRepository()),
  sqlite: ({ connection }) => new SqliteCostLedgerRepository(connection()),
});

/** A model call that cost `costUsd` (only the cost is counted). */
const call = (costUsd: number): UsageRecord =>
  ({ caller: "clerk-agent", model: "test/clerk", costUsd }) as UsageRecord;

const tenantDay: CostCounter = {
  budget: "tenant-daily-budget",
  scope: BudgetScope.Tenant,
  key: "acme",
  period: "2026-10-18",
};
const applicationMonth: CostCounter = {
  budget: "application-monthly-budget",
  scope: BudgetScope.Application,
  key: "desk-application",
  period: "2026-10-01",
};

describe.each(kinds)("#265 AC8, #261: the cost ledger ($name)", ({ twoInstances }) => {
  it("each call's cost is added to every counter, shared by the instances", async () => {
    const { first, second } = twoInstances();

    await first.saveAll([tenantDay, applicationMonth], [call(0.25), call(0.5)]);
    await second.saveAll([tenantDay], [call(0.25)]);

    expect(await first.findSpentByCounter(tenantDay)).toBe(1);
    expect(await second.findSpentByCounter(applicationMonth)).toBe(0.75);
    expect(await second.findSpentByCounter({ ...tenantDay, key: "globex" })).toBe(0);
  });

  it("a new period starts from zero; an execution's counter has no period", async () => {
    const { first, second } = twoInstances();
    const execution = { budget: "execution-budget", scope: BudgetScope.Execution, key: "run-1" };
    await first.saveAll([tenantDay, { ...execution, period: "" }], [call(0.75)]);

    expect(await second.findSpentByCounter({ ...tenantDay, period: "2026-10-19" })).toBe(0);
    expect(await second.findSpentByCounter({ ...execution, period: "" })).toBe(0.75);
  });

  it("concurrent saves of two instances lose nothing", async () => {
    const { first, second } = twoInstances();

    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        (index % 2 === 0 ? first : second).saveAll([tenantDay], [call(0.125)]),
      ),
    );

    expect(await first.findSpentByCounter(tenantDay)).toBe(1.25);
  });

  it("keeps the last maxSpend() of an account: the last known limit", async () => {
    const { first, second } = twoInstances();
    const account = { budget: tenantDay.budget, scope: tenantDay.scope, key: tenantDay.key };

    expect(await first.findMaxSpendByAccount(account)).toBeUndefined();
    await first.saveMaxSpend(account, usd(40));
    await second.saveMaxSpend(account, usd(30));

    expect(await first.findMaxSpendByAccount(account)).toBe(30);
    expect(await first.findMaxSpendByAccount({ ...account, key: "globex" })).toBeUndefined();
  });
});
