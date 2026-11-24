import {
  Weekday,
  WorkingWeek,
  type WorkingCalendarHandler,
  type WorkingWeekOptions,
} from "../../src/index.js";
import type { WorkingDuration } from "../../src/units/index.js";
import { workMs } from "./units.js";

/** Tel Aviv's office: Sunday to Thursday, 09:00–18:00 with lunch 13:00–14:00 (#944 AC1). */
export const TEL_AVIV: WorkingWeekOptions = {
  timeZone: "Asia/Jerusalem",
  days: [Weekday.Sunday, Weekday.Monday, Weekday.Tuesday, Weekday.Wednesday, Weekday.Thursday],
  hours: [{ from: "09:00", to: "18:00" }],
  breaks: [{ from: "13:00", to: "14:00" }],
};

export const ALL_DAYS = [
  Weekday.Sunday,
  Weekday.Monday,
  Weekday.Tuesday,
  Weekday.Wednesday,
  Weekday.Thursday,
  Weekday.Friday,
  Weekday.Saturday,
];

export const WEEKDAYS = [
  Weekday.Monday,
  Weekday.Tuesday,
  Weekday.Wednesday,
  Weekday.Thursday,
  Weekday.Friday,
];

/** The instant `amount` ms of working time after `from` (an ISO instant) in the grid, as an ISO instant. */
export async function after(
  grid: WorkingCalendarHandler,
  from: string,
  amount: number,
): Promise<string> {
  const answer = await grid.addWorkingTime({
    from: new Date(from),
    amount: workMs(amount),
    tenantId: "default",
    target: "test-role",
  });
  return answer.toISOString();
}

/** The instant a working duration (`workDays(2)`, `workHours(3)`) after `from`, as an ISO instant. */
export async function afterWork(
  grid: WorkingCalendarHandler,
  from: string,
  amount: WorkingDuration,
): Promise<string> {
  const answer = await grid.addWorkingTime({
    from: new Date(from),
    amount,
    tenantId: "default",
    target: "test-target",
  });
  return answer.toISOString();
}

export const week = (options: WorkingWeekOptions): WorkingCalendarHandler =>
  WorkingWeek.of(options);

export const HOUR = 3_600_000;
export const MINUTE = 60_000;
