/**
 * #633 (money shard) — the application's spend outside an execution (#261 PR 5): an evaluation's
 * judge calls count in the application budgets' counters only — each in its own period —, held to
 * the last limit an execution read; with no limit known yet nothing is limited.
 */
import { describe, expect, it } from "vitest";
import {
  isApplicationSpendExhausted,
  recordApplicationSpend,
} from "../../src/budgets/application-spend.js";
import { Budget, BudgetPeriod, BudgetScope, type BudgetHandler } from "../../src/budgets/budget.js";
import type { ApplicationBudgets } from "../../src/budgets/execution-budgets.js";
import { recordToolCost } from "../../src/finops/usage.js";
import {
  InMemoryCostLedgerRepository,
  type CostCounter,
} from "../../src/infrastructure/cost-ledger.repository.js";
import { VirtualClock } from "../../src/testing/index.js";
import { usd, type Usd } from "../../src/units/index.js";
import {
  TestApplicationDailyBudget,
  TestExecutionBudget,
  TestTenantDailyBudget,
} from "../flow/fixtures/budgets.js";

@Budget({
  name: "monthly-application-budget",
  scope: BudgetScope.Application,
  period: BudgetPeriod.Month,
})
class MonthlyApplicationBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(1000);
  }
}

const NAME = "judge-application";
/** Tuesday, 2026-10-20 (UTC): the day and the month differ from their first day. */
const NOW = new Date("2026-10-20T12:00:00.000Z");

/** The application's budgets over a fresh ledger at `NOW`. */
function applicationOf(budgets: ApplicationBudgets["budgets"]) {
  const ledger = new InMemoryCostLedgerRepository();
  const application: ApplicationBudgets = {
    budgets,
    applicationName: NAME,
    resolve: () => new TestApplicationDailyBudget(),
    ledger,
    clock: new VirtualClock(NOW),
  };
  return { ledger, application };
}

const counter = (budget: string, scope: BudgetScope, period: string): CostCounter => ({
  budget,
  scope,
  key: NAME,
  period,
});

const DAILY = counter("test-application-daily-budget", BudgetScope.Application, "2026-10-20");
const MONTHLY = counter("monthly-application-budget", BudgetScope.Application, "2026-10-01");

describe("#633: recordApplicationSpend counts in the application budgets only", () => {
  it("each application budget's counter of its own period gets the calls' cost", async () => {
    const { ledger, application } = applicationOf([
      TestTenantDailyBudget,
      TestApplicationDailyBudget,
      TestExecutionBudget,
      MonthlyApplicationBudget,
    ]);

    await recordApplicationSpend(application, [
      recordToolCost("judge", 0.25),
      recordToolCost("judge", 0.5),
    ]);

    await expect(ledger.findSpentByCounter(DAILY)).resolves.toBe(0.75);
    await expect(ledger.findSpentByCounter(MONTHLY)).resolves.toBe(0.75);
    const tenant = counter("test-tenant-daily-budget", BudgetScope.Tenant, "2026-10-20");
    await expect(ledger.findSpentByCounter(tenant)).resolves.toBe(0);
  });

  it("no application, no calls or no application budget: nothing is written", async () => {
    const written: (readonly CostCounter[])[] = [];
    const { ledger, application } = applicationOf([TestApplicationDailyBudget]);
    const tenantOnly = applicationOf([TestTenantDailyBudget]);
    for (const each of [ledger, tenantOnly.ledger]) {
      each.saveAll = (counters) => {
        written.push(counters);
        return Promise.resolve();
      };
    }

    await recordApplicationSpend(undefined, [recordToolCost("judge", 1)]);
    await recordApplicationSpend(application, []);
    await recordApplicationSpend(tenantOnly.application, [recordToolCost("judge", 1)]);

    expect(written).toEqual([]);
  });
});

describe("#633: isApplicationSpendExhausted holds the spend to the last known limit", () => {
  it("no application: never exhausted", async () => {
    await expect(isApplicationSpendExhausted(undefined)).resolves.toBe(false);
  });

  it("no limit known yet: not limited, whatever was spent", async () => {
    const { ledger, application } = applicationOf([TestApplicationDailyBudget]);
    await ledger.saveAll([DAILY], [recordToolCost("judge", 1_000_000)]);

    await expect(isApplicationSpendExhausted(application)).resolves.toBe(false);
  });

  it("the second budget exhausted, the first not: exhausted", async () => {
    const { ledger, application } = applicationOf([
      TestApplicationDailyBudget,
      MonthlyApplicationBudget,
    ]);
    await ledger.saveMaxSpend(DAILY, usd(10));
    await ledger.saveMaxSpend(MONTHLY, usd(2));
    await ledger.saveAll([DAILY, MONTHLY], [recordToolCost("judge", 2)]);

    await expect(isApplicationSpendExhausted(application)).resolves.toBe(true);
  });

  it("under the limit, or another period's spend: not exhausted", async () => {
    const { ledger, application } = applicationOf([TestApplicationDailyBudget]);
    await ledger.saveMaxSpend(DAILY, usd(2));
    await ledger.saveAll([DAILY], [recordToolCost("judge", 1.999999)]);
    await ledger.saveAll([{ ...DAILY, period: "2026-10-19" }], [recordToolCost("judge", 5)]);

    await expect(isApplicationSpendExhausted(application)).resolves.toBe(false);
  });

  it("a tenant budget's spend never exhausts the application", async () => {
    const { ledger, application } = applicationOf([TestTenantDailyBudget]);
    const tenant = counter("test-tenant-daily-budget", BudgetScope.Tenant, "2026-10-20");
    await ledger.saveMaxSpend(tenant, usd(1));
    await ledger.saveAll([tenant], [recordToolCost("judge", 5)]);

    await expect(isApplicationSpendExhausted(application)).resolves.toBe(false);
  });
});
