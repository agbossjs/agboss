/**
 * #1310b: properties of working time over time zones and the days their clocks change. A due-at must
 * never move earlier than the schedule allows, so every property is checked against an oracle that
 * shares no code with the calendar (`working-oracle.ts`): the minute scan through `Intl`.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { WorkingWeek, type WorkingCalendarHandler } from "../../src/index.js";
import { workingTimeBefore } from "../../src/calendar/working-week.js";
import { workDays, workHours, workMin, type WorkingDuration } from "../../src/units/index.js";
import { ALL_DAYS, WEEKDAYS } from "./helpers.js";
import {
  DAY,
  MINUTE,
  oracleOf,
  scanAfter,
  scanDaysAfter,
  unionOf,
  workingMinutesBetween,
  type OracleGrid,
} from "./working-oracle.js";

/** Zones with their clock changes (UTC instants): whole-hour, half-hour, 45-minute and no changes. */
const TRANSITIONS = [
  ["Europe/Berlin", "2026-03-29T01:00:00.000Z"],
  ["Europe/Berlin", "2026-10-25T01:00:00.000Z"],
  ["America/New_York", "2026-03-08T07:00:00.000Z"],
  ["America/New_York", "2026-11-01T06:00:00.000Z"],
  ["Asia/Jerusalem", "2026-03-27T00:00:00.000Z"],
  ["Asia/Jerusalem", "2026-10-24T23:00:00.000Z"],
  ["Australia/Lord_Howe", "2026-04-04T15:00:00.000Z"],
  ["Australia/Lord_Howe", "2026-10-03T15:30:00.000Z"],
  ["Pacific/Chatham", "2026-04-04T14:45:00.000Z"],
  ["Asia/Kolkata", "2026-03-29T00:00:00.000Z"],
  ["Asia/Kathmandu", "2026-03-29T00:00:00.000Z"],
  ["Europe/London", "2026-03-29T01:00:00.000Z"],
] as const;

/** Layouts of a week: an office, a night shift that a clock change cuts, split shifts with breaks. */
const LAYOUTS = [
  { days: WEEKDAYS, hours: [[540, 1080]], breaks: [[780, 840]] },
  { days: ALL_DAYS, hours: [[60, 240]], breaks: [] },
  {
    days: ALL_DAYS,
    hours: [
      [0, 360],
      [480, 1020],
      [1320, 1440],
    ],
    breaks: [
      [75, 105],
      [720, 780],
    ],
  },
  { days: [0, 1, 2, 3, 4], hours: [[480, 1200]], breaks: [] },
] as const;

const clock = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

const optionsOf = (grid: OracleGrid) => ({
  timeZone: grid.zone,
  days: [...grid.days],
  hours: grid.hours.map(([from, to]) => ({
    from: clock(from),
    to: to === 1440 ? "24:00" : clock(to),
  })),
  breaks: grid.breaks.map(([from, to]) => ({ from: clock(from), to: clock(to) })),
});

const HOLIDAYS = ["2026-03-30", "2026-04-01", "2026-10-26", "2026-11-02"];

/** A grid in a zone of the list: its layout and the holidays the oracle and the calendar both know. */
const gridArbitrary = fc
  .record({
    transition: fc.constantFrom(...TRANSITIONS),
    layout: fc.constantFrom(...LAYOUTS),
    holidays: fc.subarray(HOLIDAYS),
  })
  .map(({ transition, layout, holidays }) => ({
    transition: Date.parse(transition[1]),
    grid: { zone: transition[0], holidays, ...layout },
  }));

/** A minute within three days of the clock change. */
const startArbitrary = (transition: number) =>
  fc.integer({ min: -3 * 1440, max: 3 * 1440 }).map((minutes) => transition + minutes * MINUTE);

const calendarOf = (grid: OracleGrid): WorkingCalendarHandler =>
  WorkingWeek.of({ ...optionsOf(grid), holidays: [...grid.holidays] });

const addTo = (calendar: WorkingCalendarHandler, from: number, amount: WorkingDuration): number =>
  (calendar.addWorkingTime({ from: new Date(from), amount, tenantId: "t" }) as Date).getTime();

const RUNS = { numRuns: 60 };

describe("#1310b properties: working milliseconds, against the minute oracle", () => {
  it("k working minutes after t contain exactly k working minutes, and the last instant is working", () => {
    fc.assert(
      fc.property(
        gridArbitrary.chain(({ transition, grid }) =>
          fc.tuple(
            fc.constant(grid),
            startArbitrary(transition),
            fc.integer({ min: 1, max: 1500 }),
          ),
        ),
        ([grid, from, k]) => {
          const oracle = oracleOf(grid);
          const end = addTo(calendarOf(grid), from, workMin(k));

          expect(workingMinutesBetween(oracle, from, end)).toBe(k);
          expect(oracle.isWorking(end - MINUTE)).toBe(true);
        },
      ),
      RUNS,
    );
  });

  it("a deadline is never earlier than the wall clock allows, grows with the amount and adds up", () => {
    fc.assert(
      fc.property(
        gridArbitrary.chain(({ transition, grid }) =>
          fc.tuple(
            fc.constant(grid),
            startArbitrary(transition),
            fc.integer({ min: 1, max: 900 }),
            fc.integer({ min: 1, max: 900 }),
          ),
        ),
        ([grid, from, a, b]) => {
          const calendar = calendarOf(grid);
          const first = addTo(calendar, from, workMin(a));
          const both = addTo(calendar, from, workMin(a + b));

          expect(first).toBeGreaterThanOrEqual(from + a * MINUTE);
          expect(both).toBeGreaterThan(first);
          expect(addTo(calendar, first, workMin(b))).toBe(both);
        },
      ),
      RUNS,
    );
  });

  it("a holiday rule (isHoliday) is the same as the list of the dates it names", () => {
    fc.assert(
      fc.property(
        gridArbitrary.chain(({ transition, grid }) =>
          fc.tuple(
            fc.constant(grid),
            startArbitrary(transition),
            fc.integer({ min: 1, max: 3000 }),
          ),
        ),
        ([grid, from, k]) => {
          const listed = calendarOf(grid);
          const ruled = WorkingWeek.of({
            ...optionsOf(grid),
            isHoliday: (date) => grid.holidays.includes(date),
          });

          expect(addTo(ruled, from, workMin(k))).toBe(addTo(listed, from, workMin(k)));
          expect(addTo(ruled, from, workDays(2))).toBe(addTo(listed, from, workDays(2)));
        },
      ),
      RUNS,
    );
  });
});

describe("#1310b properties: working days, against the minute oracle", () => {
  it("n working days after t are what the per-date definition says (a clock change makes a date shorter or longer, not less of a day)", () => {
    fc.assert(
      fc.property(
        gridArbitrary.chain(({ transition, grid }) =>
          fc.tuple(
            fc.constant(grid),
            startArbitrary(transition),
            fc.constantFrom(0.25, 0.5, 1, 1.5, 2, 3, 5, 8),
          ),
        ),
        ([grid, from, days]) => {
          const expected = scanDaysAfter(oracleOf(grid), from, days, 16 * DAY);

          expect(addTo(calendarOf(grid), from, workDays(days))).toBe(expected);
        },
      ),
      { numRuns: 30 },
    );
  });

  it("grows with the number of days and ends on a working instant", () => {
    fc.assert(
      fc.property(
        gridArbitrary.chain(({ transition, grid }) =>
          fc.tuple(fc.constant(grid), startArbitrary(transition), fc.integer({ min: 1, max: 9 })),
        ),
        ([grid, from, n]) => {
          const calendar = calendarOf(grid);
          const oracle = oracleOf(grid);
          const fewer = addTo(calendar, from, workDays(n));
          const more = addTo(calendar, from, workDays(n + 1));

          expect(more).toBeGreaterThan(fewer);
          expect(fewer).toBeGreaterThan(from);
          expect(oracle.isWorking(Math.floor((fewer - 1) / MINUTE) * MINUTE)).toBe(true);
        },
      ),
      RUNS,
    );
  });
});

describe("#1310b properties: WorkingWeek.anyOf", () => {
  const poolArbitrary = fc.tuple(gridArbitrary, gridArbitrary).map(([first, second]) => ({
    transition: first.transition,
    grids: [first.grid, second.grid] as const,
  }));

  it("working minutes are counted over the union of the schedules, each hour once", () => {
    fc.assert(
      fc.property(
        poolArbitrary.chain(({ transition, grids }) =>
          fc.tuple(
            fc.constant(grids),
            startArbitrary(transition),
            fc.integer({ min: 1, max: 1500 }),
          ),
        ),
        ([grids, from, k]) => {
          const pool = WorkingWeek.anyOf(grids.map(calendarOf));
          const union = unionOf(grids.map(oracleOf));
          const end = addTo(pool, from, workMin(k));

          expect(workingMinutesBetween(union, from, end)).toBe(k);
          expect(union.isWorking(end - MINUTE)).toBe(true);
        },
      ),
      RUNS,
    );
  });

  it("is never later than any of its schedules, and no earlier than the wall clock allows", () => {
    fc.assert(
      fc.property(
        poolArbitrary.chain(({ transition, grids }) =>
          fc.tuple(
            fc.constant(grids),
            startArbitrary(transition),
            fc.integer({ min: 1, max: 1500 }),
          ),
        ),
        ([grids, from, k]) => {
          const calendars = grids.map(calendarOf);
          const pool = addTo(WorkingWeek.anyOf(calendars), from, workMin(k));

          for (const one of calendars)
            expect(pool).toBeLessThanOrEqual(addTo(one, from, workMin(k)));
          expect(pool).toBeGreaterThanOrEqual(from + k * MINUTE);
        },
      ),
      RUNS,
    );
  });

  it("working days are the earliest of the schedules' own counts, each by its own zone", () => {
    fc.assert(
      fc.property(
        poolArbitrary.chain(({ transition, grids }) =>
          fc.tuple(fc.constant(grids), startArbitrary(transition), fc.integer({ min: 1, max: 6 })),
        ),
        ([grids, from, n]) => {
          const calendars = grids.map(calendarOf);

          expect(addTo(WorkingWeek.anyOf(calendars), from, workDays(n))).toBe(
            Math.min(...calendars.map((one) => addTo(one, from, workDays(n)))),
          );
        },
      ),
      RUNS,
    );
  });
});

describe("#1310b properties: the reminder walks back along the schedule", () => {
  it("a reminder remindBefore working time ahead of a deadline has exactly that much working time before it, and never lies before the ask", () => {
    fc.assert(
      fc.property(
        gridArbitrary.chain(({ transition, grid }) =>
          fc.tuple(
            fc.constant(grid),
            startArbitrary(transition),
            fc.integer({ min: 2, max: 900 }),
            fc.integer({ min: 1, max: 899 }),
          ),
        ),
        ([grid, from, total, lead]) => {
          fc.pre(lead < total);
          const calendar = calendarOf(grid);
          const oracle = oracleOf(grid);
          const deadline = addTo(calendar, from, workMin(total));
          const remind = workingTimeBefore(calendar, new Date(deadline), workMin(lead))?.getTime();

          expect(remind).toBeDefined();
          expect(workingMinutesBetween(oracle, remind ?? 0, deadline)).toBe(lead);
          // the reminder is no earlier than the ask: the lead is part of the span
          expect(remind ?? 0).toBeGreaterThanOrEqual(from);
          // and walking forward from it by the lead returns the deadline
          expect(addTo(calendar, remind ?? 0, workMin(lead))).toBe(deadline);
        },
      ),
      RUNS,
    );
  });

  it("scanAfter agrees with the walk for hours too (the oracle is no tautology: a wall-clock sum is not it)", () => {
    const grid = { zone: "Europe/Berlin", holidays: [], ...LAYOUTS[1] } as OracleGrid;
    const from = Date.parse("2026-03-28T23:00:00.000Z");
    const calendar = calendarOf(grid);

    expect(addTo(calendar, from, workHours(2))).toBe(
      scanAfter(oracleOf(grid), from, 2 * 60 * MINUTE, 3 * DAY),
    );
    // the spring-forward night has 2 working hours, not 3: a wall-clock sum would end at 04:00 CEST + 1 h
    expect(addTo(calendar, from, workHours(3))).not.toBe(from + 3 * 60 * MINUTE + 60 * MINUTE);
  });
});
