/**
 * #1148 (from the #944 acceptance, S17 / S18): the calendar walk's own guards are pinned. The stall
 * guard ends a walk that finds no working day ahead; the day limit ends one that works but would
 * run past 25 years; the start check (`weekReaches`) counts the holidays, and what it lets through at
 * the very edge still fails typed at run time.
 */
import { describe, expect, it } from "vitest";
import { Weekday, WorkingWeek } from "../../src/index.js";
import { unestimatedWorkingWeek, weekReaches } from "../../src/calendar/working-week.js";
import { HOUR, TEL_AVIV, week } from "./helpers.js";
import { workMs } from "./units.js";

const request = (from: string, amount: number) => ({
  from: new Date(from),
  amount: workMs(amount),
  tenantId: "default",
  target: "r",
});

/** One working hour a week, Monday 09:00–10:00 UTC. */
const MONDAY_HOUR = {
  timeZone: "UTC",
  days: [Weekday.Monday],
  hours: [{ from: "09:00", to: "10:00" }],
} as const;
/** The Mondays from 2026-01-12 on, `count` of them. */
const mondays = (count: number): string[] =>
  Array.from({ length: count }, (_, index) =>
    new Date(Date.UTC(2026, 0, 12 + 7 * index)).toISOString().slice(0, 10),
  );

describe("#1148: the stall guard", () => {
  it("a grid that failed validation has no working day: the walk ends with 'no working time ahead', not at the day limit", () => {
    const none = week({ ...TEL_AVIV, days: [] });

    expect(() => none.addWorkingTime(request("2026-01-05T09:00:00.000Z", HOUR))).toThrow(
      /no working time ahead/,
    );
  });

  it("a long closed stretch is not a stall: forty Mondays of holidays in a Monday-only grid are walked", () => {
    const closed = week({ ...MONDAY_HOUR, holidays: mondays(40) });

    // the next open Monday after the forty holidays: 2026-10-19
    expect(closed.addWorkingTime(request("2026-01-05T09:00:00.000Z", HOUR))).toEqual(
      new Date("2026-01-05T10:00:00.000Z"),
    );
    expect(closed.addWorkingTime(request("2026-01-05T10:00:00.000Z", HOUR))).toEqual(
      new Date("2026-10-19T10:00:00.000Z"),
    );
  });
});

describe("#1148: the day limit", () => {
  it("a walk that works but would run past 25 years ends with a RangeError at the limit, not at its amount", () => {
    // the estimate would refuse these at once; without it the walk's own guard is the only line
    const thin = unestimatedWorkingWeek(MONDAY_HOUR);

    expect(() => thin.addWorkingTime(request("2026-01-05T09:00:00.000Z", 1400 * HOUR))).toThrow(
      /day limit/,
    );
    const withHolidays = unestimatedWorkingWeek({ ...MONDAY_HOUR, holidays: mondays(50) });
    expect(() =>
      withHolidays.addWorkingTime(request("2026-01-05T09:00:00.000Z", 1300 * HOUR)),
    ).toThrow(/day limit/);
  });

  it("the limit is exact: 1307 Monday hours (9149 days) are reached, 1308 are not", () => {
    const thin = unestimatedWorkingWeek(MONDAY_HOUR);

    expect(thin.addWorkingTime(request("2026-01-06T09:00:00.000Z", 1307 * HOUR))).toBeInstanceOf(
      Date,
    );
    expect(() => thin.addWorkingTime(request("2026-01-06T09:00:00.000Z", 1308 * HOUR))).toThrow(
      /day limit/,
    );
  });
});

describe("#1148: the start check counts the holidays", () => {
  const thin = week(MONDAY_HOUR);

  it("a span that passes without holidays is refused with fifty Monday holidays, and the walk agrees", () => {
    const withHolidays = WorkingWeek.of({ ...MONDAY_HOUR, holidays: mondays(50) });

    expect(weekReaches(thin, workMs(1307 * HOUR))).toBe(true);
    expect(weekReaches(withHolidays, workMs(1307 * HOUR))).toBe(false);
    expect(weekReaches(withHolidays, workMs(800 * HOUR))).toBe(true);
    expect(() =>
      withHolidays.addWorkingTime(request("2026-01-05T09:00:00.000Z", 1307 * HOUR)),
    ).toThrow(/25 years/);
  });

  it("a holiday costs a share of a week: 1/days of it, so a five-day week shrugs off a few hundred", () => {
    const office = WorkingWeek.of({
      timeZone: "UTC",
      days: [1, 2, 3, 4, 5],
      hours: [{ from: "09:00", to: "17:00" }],
      holidays: mondays(100),
    });
    const hoursOfYears = 40 * 52 * 20; // twenty years of a 40-hour week

    expect(weekReaches(office, workMs(hoursOfYears * HOUR))).toBe(true);
    expect(weekReaches(office, workMs(hoursOfYears * 2 * HOUR))).toBe(false);
  });

  it("a span the estimate lets through is reached by the walk, from the day after a Monday start too", () => {
    expect(weekReaches(thin, workMs(1307 * HOUR))).toBe(true);
    expect(thin.addWorkingTime(request("2026-01-06T09:00:00.000Z", 1307 * HOUR))).toBeInstanceOf(
      Date,
    );
    expect(thin.addWorkingTime(request("2026-01-05T09:00:00.000Z", 1307 * HOUR))).toBeInstanceOf(
      Date,
    );
  });
});
