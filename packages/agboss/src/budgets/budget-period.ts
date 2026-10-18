import { BudgetPeriod } from "./budget.js";

/**
 * The periods of tenant and application budgets (#261), in UTC: a period is named by its first
 * day — `2026-10-18` for that day, `2026-10-12` for the week that starts on Monday the 12th,
 * `2026-10-01` for the month. A new period starts its counters from zero.
 */

const DAY_MS = 86_400_000;

/** "2026-10-18" for any moment of that UTC day. */
const dayOf = (moment: Date): string => moment.toISOString().slice(0, 10);

/** The first UTC day of the period `moment` falls in. */
export function periodStartOf(period: BudgetPeriod, moment: Date): string {
  switch (period) {
    case BudgetPeriod.Day:
      return dayOf(moment);
    case BudgetPeriod.Week: {
      // getUTCDay: Sunday 0 … Saturday 6; a week starts on Monday (ISO 8601)
      const sinceMonday = (moment.getUTCDay() + 6) % 7;
      return dayOf(new Date(moment.getTime() - sinceMonday * DAY_MS));
    }
    case BudgetPeriod.Month:
      return `${dayOf(moment).slice(0, 7)}-01`;
  }
}

/** How a message names the period: "today", "this week", "this month". */
export function periodWords(period: BudgetPeriod): string {
  switch (period) {
    case BudgetPeriod.Day:
      return "today";
    case BudgetPeriod.Week:
      return "this week";
    case BudgetPeriod.Month:
      return "this month";
  }
}
