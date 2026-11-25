/**
 * #1306: a quorum's `deadline` in working time (`workDays(5)` + `calendar`) is the instant the
 * quorum's calendar gives — counted once at dispatch, from the application's `Clock` (fixed here:
 * a `VirtualClock` never moves on its own). The properties are checked against the minute oracle
 * that shares no code with the calendar, over time zones, their clock changes, holidays and
 * weekends; the examples are the cases a deadline most often gets wrong: a start after the last
 * shift of the week, a holiday, a zone far from UTC.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  QuorumKind,
  WorkingCalendarError,
  WorkingWeek,
  type WorkingCalendarContext,
  type WorkingCalendarHandler,
  type WorkingWeekOptions,
} from "../../../src/index.js";
import type { CountQuorum, GroupsQuorum } from "../../../src/flow/ast.js";
import {
  quorumDeadlineAt,
  type DeadlineSite,
} from "../../../src/flow/runtime/launch/launch-exit.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import {
  seconds,
  workDays,
  workHours,
  workMin,
  type WorkingDuration,
} from "../../../src/units/index.js";
import { testFrame } from "../../helpers/frame.js";
import { ALL_DAYS, TEL_AVIV, WEEKDAYS } from "../../calendar/helpers.js";
import { DAY, MINUTE, oracleOf, scanAfter, scanDaysAfter } from "../../calendar/working-oracle.js";
import type { OracleGrid } from "../../calendar/working-oracle.js";

/** The class a quorum names; its instance is whatever the container gives. */
class OfficeCalendar {
  readonly name = "office";
}

/** A site whose container gives `handler` for the calendar class; the clock is fixed at `now`. */
const siteOf = (handler: WorkingCalendarHandler, now: Date): DeadlineSite => ({
  frame: testFrame(),
  clock: new VirtualClock(now),
  container: { get: () => handler as never },
});

const countQuorum = (deadline: WorkingDuration): CountQuorum => ({
  kind: QuorumKind.Count,
  min: 1,
  deadline,
  calendar: OfficeCalendar,
});

const deadlineOf = (handler: WorkingCalendarHandler, from: number, span: WorkingDuration) =>
  quorumDeadlineAt(countQuorum(span), new Date(from), siteOf(handler, new Date(from)));

const iso = (epoch: number | undefined): string | undefined =>
  epoch === undefined ? undefined : new Date(epoch).toISOString();

describe("#1306: the instant of a working-time quorum deadline, by examples", () => {
  const telAviv = WorkingWeek.of(TEL_AVIV);

  it("a start after the week's last shift (Thursday 17:30 in Tel Aviv): 1 working hour is Sunday 09:30, the weekend skipped", async () => {
    const at = await deadlineOf(telAviv, Date.parse("2026-01-08T15:30:00.000Z"), workHours(1));

    // 17:30–18:00 is half an hour of Thursday; the other half hour is Sunday 09:00–09:30
    expect(iso(at)).toBe("2026-01-11T07:30:00.000Z");
  });

  it("a holiday is no working day: with Sunday off, the same deadline falls on Monday", async () => {
    const holiday = WorkingWeek.of({ ...TEL_AVIV, holidays: ["2026-01-11"] });

    const at = await deadlineOf(holiday, Date.parse("2026-01-08T15:30:00.000Z"), workHours(1));

    expect(iso(at)).toBe("2026-01-12T07:30:00.000Z");
  });

  it("a zone far from UTC: Friday 16:30 in New York, 60 working minutes, is Monday 09:30 there", async () => {
    const newYork = WorkingWeek.of({
      timeZone: "America/New_York",
      days: WEEKDAYS,
      hours: [{ from: "09:00", to: "17:00" }],
    });

    const at = await deadlineOf(newYork, Date.parse("2026-01-09T21:30:00.000Z"), workMin(60));

    expect(iso(at)).toBe("2026-01-12T14:30:00.000Z");
  });

  it("working days count days of the schedule, not 24 hours: 2 days from Thursday morning is Sunday, past the weekend", async () => {
    const at = await deadlineOf(telAviv, Date.parse("2026-01-08T07:00:00.000Z"), workDays(2));

    expect(new Date(at ?? 0).toISOString().slice(0, 10)).toBe("2026-01-11");
  });

  it("a plain duration is wall-clock time added to the moment of dispatch, no calendar asked", async () => {
    const asked: WorkingCalendarContext[] = [];
    const spy = {
      addWorkingTime: (request: WorkingCalendarContext) => {
        asked.push(request);
        return new Date(0);
      },
    };
    const now = new Date("2026-01-05T09:00:00.000Z");
    const quorum: GroupsQuorum = { kind: QuorumKind.Groups, groups: [], deadline: seconds(30) };

    const at = await quorumDeadlineAt(quorum, now, siteOf(spy, now));

    expect(at).toBe(now.getTime() + 30_000);
    expect(asked).toEqual([]);
  });

  it("no deadline, no instant", async () => {
    const now = new Date("2026-01-05T09:00:00.000Z");
    const quorum: GroupsQuorum = { kind: QuorumKind.Groups, groups: [] };

    expect(await quorumDeadlineAt(quorum, now, siteOf(telAviv, now))).toBeUndefined();
    expect(await quorumDeadlineAt(undefined, now, siteOf(telAviv, now))).toBeUndefined();
  });

  it("the calendar is asked for the tenant of the execution, the dispatch moment and the amount, with no target and no assignees", async () => {
    const asked: WorkingCalendarContext[] = [];
    const spy: WorkingCalendarHandler = {
      addWorkingTime: (request) => {
        asked.push(request);
        return new Date(request.from.getTime() + 3_600_000);
      },
    };
    const now = new Date("2026-01-05T09:00:00.000Z");

    await quorumDeadlineAt(countQuorum(workDays(3)), now, siteOf(spy, now));

    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ from: now, amount: workDays(3), tenantId: "default" });
    expect(asked[0]).not.toHaveProperty("target");
    expect(asked[0]).not.toHaveProperty("assignees");
  });

  it("a calendar that throws is a WorkingCalendarError, never a wall-clock deadline", async () => {
    const broken: WorkingCalendarHandler = {
      addWorkingTime: () => {
        throw new Error("the holiday table is down");
      },
    };
    const now = new Date("2026-01-05T09:00:00.000Z");

    const failure = quorumDeadlineAt(countQuorum(workDays(1)), now, siteOf(broken, now));

    await expect(failure).rejects.toBeInstanceOf(WorkingCalendarError);
    await expect(failure).rejects.not.toThrow("holiday table");
  });

  it("a calendar that answers a date not after the start is a WorkingCalendarError", async () => {
    const stuck: WorkingCalendarHandler = { addWorkingTime: (request) => request.from };
    const now = new Date("2026-01-05T09:00:00.000Z");

    await expect(
      quorumDeadlineAt(countQuorum(workHours(1)), now, siteOf(stuck, now)),
    ).rejects.toBeInstanceOf(WorkingCalendarError);
  });
});

/** Zones with the instants their clocks change. */
const TRANSITIONS = [
  ["Europe/Berlin", "2026-03-29T01:00:00.000Z"],
  ["America/New_York", "2026-11-01T06:00:00.000Z"],
  ["Asia/Jerusalem", "2026-10-24T23:00:00.000Z"],
  ["Australia/Lord_Howe", "2026-04-04T15:00:00.000Z"],
  ["Asia/Kolkata", "2026-03-29T00:00:00.000Z"],
] as const;

const LAYOUTS = [
  { days: WEEKDAYS, hours: [[540, 1080]], breaks: [[780, 840]] },
  { days: ALL_DAYS, hours: [[60, 240]], breaks: [] },
  { days: [0, 1, 2, 3, 4], hours: [[480, 1200]], breaks: [] },
] as const;

const HOLIDAYS = ["2026-03-30", "2026-04-01", "2026-10-26", "2026-11-02"];

const clockText = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

const weekOf = (grid: OracleGrid): WorkingCalendarHandler => {
  const options: WorkingWeekOptions = {
    timeZone: grid.zone,
    days: [...grid.days],
    hours: grid.hours.map(([from, to]) => ({ from: clockText(from), to: clockText(to) })),
    breaks: grid.breaks.map(([from, to]) => ({ from: clockText(from), to: clockText(to) })),
    holidays: [...grid.holidays],
  };
  return WorkingWeek.of(options);
};

/** A grid in a zone of the list, with a start within three days of its clock change. */
const scenario = fc
  .record({
    transition: fc.constantFrom(...TRANSITIONS),
    layout: fc.constantFrom(...LAYOUTS),
    holidays: fc.subarray(HOLIDAYS),
    shift: fc.integer({ min: -3 * 1440, max: 3 * 1440 }),
  })
  .map(({ transition, layout, holidays, shift }) => ({
    grid: { zone: transition[0], holidays, ...layout } satisfies OracleGrid,
    from: Date.parse(transition[1]) + shift * MINUTE,
  }));

describe("#1306 properties: the quorum's deadline, against the minute oracle", () => {
  it("workDays(n) is the instant the per-date definition gives, over zones, clock changes and holidays", async () => {
    await fc.assert(
      fc.asyncProperty(scenario, fc.constantFrom(0.5, 1, 2, 3, 5), async ({ grid, from }, days) => {
        const at = await deadlineOf(weekOf(grid), from, workDays(days));

        expect(at).toBe(scanDaysAfter(oracleOf(grid), from, days, 16 * DAY));
      }),
      { numRuns: 25 },
    );
  });

  it("workMin(k) holds exactly k working minutes, never earlier than the wall clock allows", async () => {
    await fc.assert(
      fc.asyncProperty(scenario, fc.integer({ min: 1, max: 1500 }), async ({ grid, from }, k) => {
        const at = await deadlineOf(weekOf(grid), from, workMin(k));

        expect(at).toBe(scanAfter(oracleOf(grid), from, k * MINUTE, 16 * DAY));
        expect(at).toBeGreaterThanOrEqual(from + k * MINUTE);
      }),
      { numRuns: 25 },
    );
  });

  it("the deadline is strictly after the dispatch moment, and grows with the amount", async () => {
    await fc.assert(
      fc.asyncProperty(
        scenario,
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 1, max: 6 }),
        async ({ grid, from }, first, more) => {
          const week = weekOf(grid);

          const shorter = (await deadlineOf(week, from, workDays(first))) ?? 0;
          const longer = (await deadlineOf(week, from, workDays(first + more))) ?? 0;

          expect(shorter).toBeGreaterThan(from);
          expect(longer).toBeGreaterThan(shorter);
        },
      ),
      { numRuns: 25 },
    );
  });
});
