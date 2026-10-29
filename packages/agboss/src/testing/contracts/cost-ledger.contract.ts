import { expect } from "vitest";
import { BudgetScope } from "../../budgets/budget.js";
import type { UsageRecord } from "../../finops/usage.js";
import type {
  CostCounter,
  CostLedgerRepository,
} from "../../infrastructure/cost-ledger.repository.js";
import { usd } from "../../units/index.js";
import { pingOf, registerContract, type ContractCase } from "./define.js";
import type { ContractTarget } from "./seam.js";

/** A model call that cost `costUsd` (only the cost is counted). */
const call = (costUsd: number): UsageRecord => ({
  caller: "clerk-agent",
  model: "test/clerk",
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd,
  costSource: "api",
});

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

const LEDGER_CASES: readonly ContractCase<CostLedgerRepository>[] = [
  {
    name: "each call's cost is added to every counter, shared by the instances",
    run: async ({ first, second }) => {
      await first.saveAll([tenantDay, applicationMonth], [call(0.25), call(0.5)]);
      await second.saveAll([tenantDay], [call(0.25)]);

      expect(await first.findSpentByCounter(tenantDay)).toBe(1);
      expect(await second.findSpentByCounter(applicationMonth)).toBe(0.75);
      expect(await second.findSpentByCounter({ ...tenantDay, key: "globex" })).toBe(0);
    },
  },
  {
    name: "a new period starts from zero; an execution's counter has no period",
    run: async ({ first, second }) => {
      const execution = { budget: "execution-budget", scope: BudgetScope.Execution, key: "run-1" };
      await first.saveAll([tenantDay, { ...execution, period: "" }], [call(0.75)]);

      expect(await second.findSpentByCounter({ ...tenantDay, period: "2026-10-19" })).toBe(0);
      expect(await second.findSpentByCounter({ ...execution, period: "" })).toBe(0.75);
    },
  },
  {
    name: "concurrent saves of two instances lose nothing",
    run: async ({ first, second }) => {
      await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          (index % 2 === 0 ? first : second).saveAll([tenantDay], [call(0.125)]),
        ),
      );

      expect(await first.findSpentByCounter(tenantDay)).toBe(1.25);
    },
  },
  {
    name: "keeps the last maxSpend() of an account: the last known limit",
    run: async ({ first, second }) => {
      const account = { budget: tenantDay.budget, scope: tenantDay.scope, key: tenantDay.key };

      expect(await first.findMaxSpendByAccount(account)).toBeUndefined();
      await first.saveMaxSpend(account, usd(40));
      await second.saveMaxSpend(account, usd(30));

      expect(await first.findMaxSpendByAccount(account)).toBe(30);
      expect(await first.findMaxSpendByAccount({ ...account, key: "globex" })).toBeUndefined();
    },
  },
];

/**
 * `CostLedgerRepository` (#265 AC8, #261 PR 5): one counter per budget, scope key and period, each
 * call's cost added to every counter it is given, nothing lost between instances; the last
 * `maxSpend()` per budget and scope key.
 */
export function costLedgerContract(target: ContractTarget<CostLedgerRepository>): void {
  registerContract("cost ledger contract", target, [{ cases: LEDGER_CASES }], pingOf);
}
