import type { UsageRecord } from "../finops/usage.js";
import { budgetOf, BudgetScope } from "./budget.js";
import {
  counterOf,
  type ApplicationBudgets,
  type ExecutionBudgetRecord,
} from "./execution-budgets.js";

/**
 * The application's spend outside any execution (#261 PR 5): an evaluation's judge calls
 * (`agboss eval`, `replay`, `compare`). They count in the application budgets' counters like any
 * call; and since the framework never calls `maxSpend()` outside an execution, the limit they are
 * held to is the last known one — the `maxSpend()` the last execution read, kept in the ledger.
 */

/** The application budgets with their last known amounts (none known yet → not limited). */
async function applicationRecords(
  application: ApplicationBudgets,
): Promise<readonly ExecutionBudgetRecord[]> {
  const records: ExecutionBudgetRecord[] = [];
  for (const type of application.budgets) {
    const meta = budgetOf(type);
    if (meta?.scope !== BudgetScope.Application) continue;
    const account = {
      budget: meta.name,
      scope: meta.scope,
      key: application.applicationName,
    };
    const known = await application.ledger.findMaxSpendByAccount(account);
    records.push({
      budget: { name: meta.name },
      scope: meta.scope,
      ...(meta.period === undefined ? {} : { period: meta.period }),
      key: application.applicationName,
      maxSpend: known ?? Number.POSITIVE_INFINITY,
    });
  }
  return records;
}

/** Whether an application budget is exhausted by its last known limit. */
export async function isApplicationSpendExhausted(
  application: ApplicationBudgets | undefined,
): Promise<boolean> {
  if (application === undefined) return false;
  const now = application.clock();
  for (const record of await applicationRecords(application)) {
    const spent = await application.ledger.findSpentByCounter(counterOf(record, now));
    if (spent >= record.maxSpend) return true;
  }
  return false;
}

/** Counts calls made outside an execution in every application budget. */
export async function recordApplicationSpend(
  application: ApplicationBudgets | undefined,
  records: readonly UsageRecord[],
): Promise<void> {
  if (application === undefined || records.length === 0) return;
  const now = application.clock();
  const counters = (await applicationRecords(application)).map((record) => counterOf(record, now));
  if (counters.length > 0) await application.ledger.saveAll(counters, records);
}
