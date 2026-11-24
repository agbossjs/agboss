/**
 * #1310b: one question to a pause's calendar — a calendar that resolves a schedule
 * (`resolveSchedule`) leaves the DST and interval arithmetic to the core; a declared week is a grid;
 * a reminder of a working deadline is walked back along the resolved schedule from the (clamped)
 * deadline, or, for a calendar that can only add, forward in one unit. A calendar that cannot answer
 * is a `WorkingCalendarError` with no calendar text in its message.
 */
import { describe, expect, it } from "vitest";
import {
  WorkingCalendar,
  WorkingCalendarError,
  WorkingCalendarProblem,
  WorkingWeek,
  type WorkingCalendarContext,
  type WorkingCalendarHandler,
} from "../../src/index.js";
import {
  workingReminderAt,
  workingTimeAfter,
  type CalendarSite,
  type PauseCalendar,
} from "../../src/calendar/calendar-call.js";
import { pauseCalendarOf } from "../../src/calendar/calendar-source.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { seconds, workDays, workHours, workMin, type Milliseconds } from "../../src/units/index.js";
import { testFrame } from "../helpers/frame.js";
import { TEL_AVIV } from "./helpers.js";

const ASKED = new Date("2026-01-11T07:00:00.000Z"); // Sunday 09:00 in Tel Aviv

const siteOf = (
  calendar: PauseCalendar | undefined,
  extra: Partial<CalendarSite> = {},
): CalendarSite & { readonly clock: VirtualClock } => ({
  calendar,
  tenantId: "acme",
  role: "refund-approval",
  frame: testFrame(),
  ...extra,
  clock: new VirtualClock(ASKED),
});

/** A class with `resolveSchedule`: what it was asked is kept, the schedule is `schedule()`. */
const resolving = (schedule: () => unknown, timeout?: Milliseconds) => {
  const asked: WorkingCalendarContext[] = [];
  const handler = {
    resolveSchedule: (request: WorkingCalendarContext) => {
      asked.push(request);
      return schedule();
    },
  } as unknown as WorkingCalendarHandler;
  return { asked, calendar: { name: "resolving-calendar", handler, timeout } };
};

describe("#1310b: resolveSchedule", () => {
  it("the core walks the schedule the calendar resolves, for the tenant, the target and the assignees", async () => {
    const { asked, calendar } = resolving(() => WorkingWeek.of(TEL_AVIV));

    const due = await workingTimeAfter(
      siteOf(calendar, { assignees: ["u-1", "u-2"] }),
      ASKED,
      workHours(3),
    );

    // Sunday 09:00–13:00 IST has 4 hours: 3 of them end at 12:00 IST
    expect(due).toEqual(new Date("2026-01-11T10:00:00.000Z"));
    expect(asked).toEqual([
      {
        from: ASKED,
        amount: workHours(3),
        tenantId: "acme",
        target: "refund-approval",
        assignees: ["u-1", "u-2"],
      },
    ]);
  });

  it("works days of the resolved schedule: a pool of two zones ends with the earliest day", async () => {
    const tokyo = WorkingWeek.of({
      ...TEL_AVIV,
      timeZone: "Asia/Tokyo",
      days: [0, 1, 2, 3, 4, 5, 6],
    });
    const { calendar } = resolving(() => WorkingWeek.anyOf([WorkingWeek.of(TEL_AVIV), tokyo]));

    const due = await workingTimeAfter(siteOf(calendar), ASKED, workDays(1));

    // Tokyo's date that holds 07:00Z (16:00 JST) has 2 hours left of 8: a quarter; then Monday's 9-18
    expect(due.getTime()).toBeGreaterThan(ASKED.getTime());
    expect(due.getTime()).toBeLessThanOrEqual(new Date("2026-01-11T16:00:00.000Z").getTime());
  });

  it.each([
    ["an invalid week", () => WorkingWeek.of({ ...TEL_AVIV, timeZone: "Mars/Olympus" })],
    ["an empty anyOf", () => WorkingWeek.anyOf([])],
    ["nothing", () => undefined],
    ["a string", () => "Asia/Jerusalem"],
    ["an object with no addWorkingTime", () => ({ days: [1] })],
  ])("%s as the schedule is invalid-schedule, never a deadline", async (_label, schedule) => {
    const { calendar } = resolving(schedule);

    const failed: unknown = await workingTimeAfter(siteOf(calendar), ASKED, workHours(1)).catch(
      (error: unknown) => error,
    );

    expect(failed).toBeInstanceOf(WorkingCalendarError);
    expect(failed).toMatchObject({ problem: WorkingCalendarProblem.InvalidSchedule });
    expect((failed as Error).message).toBe("working calendar resolving-calendar: invalid-schedule");
  });

  it("a resolver that throws is calendar-failed with none of its text in the message", async () => {
    const { calendar } = resolving(() => {
      throw new Error("the HR table of Jane Doe is down");
    });

    const failed: unknown = await workingTimeAfter(siteOf(calendar), ASKED, workHours(1)).catch(
      (error: unknown) => error,
    );

    expect(failed).toMatchObject({ problem: WorkingCalendarProblem.CalendarFailed });
    expect((failed as Error).message).not.toContain("Jane Doe");
  });

  it("a schedule that cannot give the time asked is calendar-failed (no working time in 25 years)", async () => {
    const { calendar } = resolving(() => WorkingWeek.of(TEL_AVIV));

    const failed: unknown = await workingTimeAfter(
      siteOf(calendar),
      ASKED,
      workHours(24 * 365 * 40),
    ).catch((error: unknown) => error);

    expect(failed).toMatchObject({ problem: WorkingCalendarProblem.CalendarFailed });
  });

  it("the calendar's own timeout bounds its answer on the clock, not the tool timeout", async () => {
    const hang = resolving(() => new Promise<never>(() => undefined), seconds(5));
    const site = siteOf(hang.calendar);
    const pending = workingTimeAfter(site, ASKED, workHours(1)).catch((error: unknown) => error);

    await site.clock.advance(seconds(4));
    await site.clock.advance(seconds(2));

    expect(await pending).toMatchObject({ problem: WorkingCalendarProblem.CalendarTimeout });
  });
});

describe("#1310b: a declared week", () => {
  it("@WorkingCalendar({ week }) on an empty class is a grid: no instance is made, one grid per class", async () => {
    @WorkingCalendar({ name: "tel-aviv-office", week: TEL_AVIV })
    class TelAvivOffice {}
    const made: unknown[] = [];

    const calendar = pauseCalendarOf(TelAvivOffice, (cls) => made.push(cls));
    const again = pauseCalendarOf(TelAvivOffice, (cls) => made.push(cls));

    expect(made).toEqual([]);
    expect(calendar?.handler).toBe(again?.handler);
    expect(calendar?.name).toBe("tel-aviv-office");
    expect(await workingTimeAfter(siteOf(calendar), ASKED, workHours(3))).toEqual(
      new Date("2026-01-11T10:00:00.000Z"),
    );
    expect(await workingTimeAfter(siteOf(calendar), ASKED, workDays(1))).toEqual(
      new Date("2026-01-11T16:00:00.000Z"),
    );
  });

  it("its timeout is sec(30) unless it says otherwise", () => {
    @WorkingCalendar({ week: TEL_AVIV })
    class Default {}
    @WorkingCalendar({ week: TEL_AVIV, timeout: seconds(2) })
    class Quick {}

    expect(pauseCalendarOf(Default, () => undefined)?.timeout).toBe(seconds(30));
    expect(pauseCalendarOf(Quick, () => undefined)?.timeout).toBe(seconds(2));
  });
});

describe("#1310b: the reminder of a working deadline", () => {
  const grid: PauseCalendar = { name: "grid", handler: WorkingWeek.of(TEL_AVIV) };
  const deadline = new Date("2026-01-11T10:00:00.000Z"); // 12:00 IST: 3 working hours after the ask

  it("is walked back from the deadline along the schedule, over a break and a night", async () => {
    // 45 minutes before 12:00 IST is 11:15 IST
    expect(
      await workingReminderAt(siteOf(grid), {
        at: ASKED,
        expiresAt: deadline,
        expiresIn: workHours(3),
        remindBefore: workMin(45),
      }),
    ).toEqual(new Date("2026-01-11T09:15:00.000Z"));
    // 5 working hours before Monday 10:00 IST: 4 hours of Monday 09:00–10:00 (1) + Sunday 14:00–18:00 (4)
    expect(
      await workingReminderAt(siteOf(grid), {
        at: ASKED,
        expiresAt: new Date("2026-01-12T08:00:00.000Z"),
        expiresIn: workHours(9),
        remindBefore: workHours(5),
      }),
    ).toEqual(new Date("2026-01-11T12:00:00.000Z"));
  });

  it("follows a deadline a bound pulled in: never later than it, none when it falls on or before the ask", async () => {
    const pulledIn = new Date("2026-01-11T07:30:00.000Z"); // the run's deadline: 30 minutes after the ask

    expect(
      await workingReminderAt(siteOf(grid), {
        at: ASKED,
        expiresAt: pulledIn,
        expiresIn: workHours(3),
        remindBefore: workMin(15),
      }),
    ).toEqual(new Date("2026-01-11T07:15:00.000Z"));
    expect(
      await workingReminderAt(siteOf(grid), {
        at: ASKED,
        expiresAt: pulledIn,
        expiresIn: workHours(3),
        remindBefore: workMin(45),
      }),
    ).toBeUndefined();
  });

  it("counts a reminder in hours before a deadline in days on a grid: the units need not match", async () => {
    const mixed = await workingReminderAt(siteOf(grid), {
      at: ASKED,
      expiresAt: new Date("2026-01-13T15:00:00.000Z"),
      expiresIn: workDays(3),
      remindBefore: workHours(4),
    });

    // Tuesday 17:00 IST, 4 working hours back: 14:00–17:00 is 3, then 12:00–13:00 before the break
    expect(mixed).toEqual(new Date("2026-01-13T10:00:00.000Z"));
  });

  it("a calendar that can only add places it forward (expiresIn − remindBefore) in one unit", async () => {
    const asked: WorkingCalendarContext[] = [];
    const adder: PauseCalendar = {
      name: "adder",
      handler: {
        addWorkingTime: (request) => {
          asked.push(request);
          return new Date(request.from.getTime() + request.amount.amount * 2);
        },
      },
    };

    const remindAt = await workingReminderAt(siteOf(adder), {
      at: ASKED,
      expiresAt: new Date(ASKED.getTime() + 3 * 3_600_000 * 2),
      expiresIn: workHours(3),
      remindBefore: workHours(1),
    });

    expect(asked).toEqual([
      {
        from: ASKED,
        amount: workHours(2),
        tenantId: "acme",
        target: "refund-approval",
      },
    ]);
    // the 2-hour lead, doubled by this calendar
    expect(remindAt).toEqual(new Date(ASKED.getTime() + 2 * 3_600_000 * 2));
  });

  it("a calendar that can only add refuses to mix units: mixed-units, nobody is asked", async () => {
    const asked: unknown[] = [];
    const adder: PauseCalendar = {
      name: "adder",
      handler: {
        addWorkingTime: (request) => {
          asked.push(request);
          return new Date(request.from.getTime() + 1);
        },
      },
    };

    const failed: unknown = await workingReminderAt(siteOf(adder), {
      at: ASKED,
      expiresAt: new Date(ASKED.getTime() + 1_000_000),
      expiresIn: workDays(2),
      remindBefore: workHours(4),
    }).catch((error: unknown) => error);

    expect(failed).toMatchObject({ problem: WorkingCalendarProblem.MixedUnits });
    expect(asked).toEqual([]);
  });

  it("a calendar that can only add and a lead that is not positive: none, nobody is asked", async () => {
    const asked: unknown[] = [];
    const adder: PauseCalendar = {
      name: "adder",
      handler: { addWorkingTime: (request) => (asked.push(request), new Date(1)) },
    };

    expect(
      await workingReminderAt(siteOf(adder), {
        at: ASKED,
        expiresAt: new Date(ASKED.getTime() + 1_000_000),
        expiresIn: workHours(1),
        remindBefore: workHours(1),
      }),
    ).toBeUndefined();
    expect(asked).toEqual([]);
  });
});
