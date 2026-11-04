/**
 * #633 (money shard) — the in-memory cost ledger's row keys: an account's parts are kept apart, so
 * two accounts whose names run together are two rows; and it answers its ping.
 */
import { describe, expect, it } from "vitest";
import { BudgetScope } from "../../src/budgets/budget.js";
import { recordToolCost } from "../../src/finops/usage.js";
import { InMemoryCostLedgerRepository } from "../../src/infrastructure/cost-ledger.repository.js";
import { usd } from "../../src/units/index.js";

describe("#633: the in-memory cost ledger keeps accounts apart", () => {
  const first = { budget: "x", scope: BudgetScope.Tenant, key: "tenanty" };
  const second = { budget: "xtenant", scope: BudgetScope.Tenant, key: "y" };

  it("two accounts whose budget, scope and key run together: two limits, two counters", async () => {
    const ledger = new InMemoryCostLedgerRepository();

    await ledger.saveMaxSpend(first, usd(5));
    await ledger.saveAll([{ ...first, period: "2026-10-20" }], [recordToolCost("judge", 1)]);

    await expect(ledger.findMaxSpendByAccount(second)).resolves.toBeUndefined();
    await expect(ledger.findSpentByCounter({ ...second, period: "2026-10-20" })).resolves.toBe(0);
  });

  it("answers its ping", async () => {
    await expect(new InMemoryCostLedgerRepository().ping()).resolves.toBeUndefined();
  });
});
