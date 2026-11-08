import { randomUUID } from "node:crypto";
import { BudgetScope } from "../../budgets/budget.js";
import { CostSource } from "../../finops/usage.js";
import type { CostCounter, LedgerEntry } from "../../infrastructure/cost-ledger.repository.js";
import { usd } from "../../units/index.js";

/** The cost ledger contract's data: entries and the counters its cases save to. */

/** When the cases' calls are made unless a case dates its own: after every cutoff they prune at. */
const MADE_AT = "2026-10-18T12:00:00.000Z";

/** The spend of one model call under `ledgerId`, made at `madeAt` (only the cost is counted). */
export const entry = (ledgerId: string, costUsd: number, madeAt = MADE_AT): LedgerEntry => ({
  caller: "clerk-agent",
  model: "test/clerk",
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: usd(costUsd),
  costSource: CostSource.Api,
  ledgerId,
  madeAt: new Date(madeAt),
});

/** A call of its own that cost `costUsd`: an entry under an id no other call has. */
export const call = (costUsd: number): LedgerEntry => entry(`call:${randomUUID()}`, costUsd);

export const tenantDay: CostCounter = {
  budget: "tenant-daily-budget",
  scope: BudgetScope.Tenant,
  key: "acme",
  period: "2026-10-18",
};
export const applicationMonth: CostCounter = {
  budget: "application-monthly-budget",
  scope: BudgetScope.Application,
  key: "desk-application",
  period: "2026-10-01",
};
