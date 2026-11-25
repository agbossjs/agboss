import type { CostReport } from "../../finops/cost-report.js";
import type { UsageRecord } from "../../finops/usage.js";

/**
 * How a paid error reads its spend: `CostReport.fromUsage`, which `finops/cost-report` sets when it
 * loads. The family machinery imports no finops module at run time — `finops/cost-report` → units →
 * `ConfigError` → the machinery is a cycle, and a process whose first import was the machinery
 * defined `ConfigError` before the machinery's module had run (a child under tsx failed at load).
 * Each module defining a paid family imports `finops/cost-report`, so the report is always set.
 */
let report: ((usage: readonly UsageRecord[]) => CostReport) | undefined;

/** Called once by `finops/cost-report`. */
export const setSpendReport = (of: (usage: readonly UsageRecord[]) => CostReport): void => {
  report = of;
};

/** The spend of `usage`; never a silent `undefined`: unset, the read throws. */
export function spendReportOf(usage: readonly UsageRecord[]): CostReport {
  if (report === undefined)
    throw new TypeError("the spend of a paid error was read before finops/cost-report was loaded");
  return report(usage);
}
