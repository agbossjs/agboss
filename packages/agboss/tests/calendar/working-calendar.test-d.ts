/**
 * #1310b, at compile time: `WorkingDuration` is `{ unit, amount }`; a calendar is asked a
 * `WorkingCalendarContext` (a target and assignees, no `channel`); `WorkingWeek.anyOf` merges
 * schedules; `@WorkingCalendar` has a declarative form (`week`, an empty class) and a dynamic form
 * (`resolveSchedule` or `addWorkingTime`, `deps`); the old names are gone.
 */
import { describe, expectTypeOf, it } from "vitest";
import {
  WorkingCalendar,
  WorkingWeek,
  type TimeWindow,
  type WorkingCalendarContext,
  type WorkingCalendarHandler,
  type WorkingScheduleResolver,
  type WorkingWeekOptions,
} from "../../src/index.js";
import { workDays, workHours, workMin, type WorkingDuration } from "../../src/units/index.js";
import { amountOf, unitOf } from "../../src/units/working-time.js";

describe("#1310b: working durations and the calendar's request", () => {
  it("a working duration counts working milliseconds or working days", () => {
    expectTypeOf(workDays(2)).toEqualTypeOf<WorkingDuration>();
    expectTypeOf(workHours(2)).toEqualTypeOf<WorkingDuration>();
    expectTypeOf(workMin(2)).toEqualTypeOf<WorkingDuration>();
    expectTypeOf(workDays(2).unit).toEqualTypeOf<"ms" | "days">();
    expectTypeOf(workDays(2).amount).toEqualTypeOf<number>();
    expectTypeOf(amountOf(workDays(2))).toEqualTypeOf<number>();
    expectTypeOf(unitOf(workDays(2))).toEqualTypeOf<"ms" | "days">();
  });

  it("the request has the target and the assignees, and the amount is a working duration", () => {
    expectTypeOf<WorkingCalendarContext["amount"]>().toEqualTypeOf<WorkingDuration>();
    expectTypeOf<WorkingCalendarContext["target"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<WorkingCalendarContext["assignees"]>().toEqualTypeOf<
      readonly string[] | undefined
    >();
    expectTypeOf<WorkingCalendarContext>().not.toHaveProperty("channel");
  });

  it("the old names are gone", () => {
    // @ts-expect-error ClockInterval is TimeWindow
    type Gone = import("../../src/index.js").ClockInterval;
    // @ts-expect-error WorkingTimeRequest is WorkingCalendarContext
    type AlsoGone = import("../../src/index.js").WorkingTimeRequest;
    expectTypeOf<TimeWindow>().toEqualTypeOf<{ readonly from: string; readonly to: string }>();
    expectTypeOf<Gone>().toBeAny();
    expectTypeOf<AlsoGone>().toBeAny();
  });
});

describe("#1310b: WorkingWeek", () => {
  it("of takes options with an isHoliday rule; anyOf merges calendars", () => {
    expectTypeOf<WorkingWeekOptions["isHoliday"]>().toEqualTypeOf<
      ((localDate: string) => boolean) | undefined
    >();
    expectTypeOf<Parameters<typeof WorkingWeek.anyOf>[0]>().toEqualTypeOf<
      readonly WorkingCalendarHandler[]
    >();
    expectTypeOf<ReturnType<typeof WorkingWeek.anyOf>>().toEqualTypeOf<WorkingCalendarHandler>();
  });
});

describe("#1310b: @WorkingCalendar", () => {
  const week: WorkingWeekOptions = {
    timeZone: "UTC",
    days: [1],
    hours: [{ from: "09:00", to: "17:00" }],
  };

  it("takes a week on an empty class", () => {
    @WorkingCalendar({ week })
    class Declared {}

    expectTypeOf(Declared).toBeConstructibleWith();
  });

  it("refuses a week on a class with arithmetic of its own, or with deps", () => {
    // @ts-expect-error a declared week is the whole calendar: no addWorkingTime beside it
    @WorkingCalendar({ week })
    class Both {
      addWorkingTime(): Date {
        return new Date(0);
      }
    }
    // @ts-expect-error a declared week has no dependencies
    @WorkingCalendar({ week, deps: [Date] })
    class WithDeps {}
    expectTypeOf(Both).toBeConstructibleWith();
    expectTypeOf(WithDeps).toBeConstructibleWith();
  });

  it("takes resolveSchedule or addWorkingTime without implements", () => {
    @WorkingCalendar({ name: "resolving" })
    class Resolving {
      resolveSchedule(): WorkingCalendarHandler {
        return WorkingWeek.of(week);
      }
    }
    @WorkingCalendar({ name: "adding" })
    class Adding {
      addWorkingTime(request: WorkingCalendarContext): Promise<Date> {
        return Promise.resolve(request.from);
      }
    }
    expectTypeOf(new Resolving()).toExtend<WorkingScheduleResolver>();
    expectTypeOf(new Adding()).toExtend<WorkingCalendarHandler>();
  });

  it("refuses a class with neither", () => {
    // @ts-expect-error a calendar resolves a schedule or adds working time
    @WorkingCalendar({ name: "neither" })
    class Neither {
      somethingElse(): number {
        return 1;
      }
    }
    expectTypeOf(Neither).toBeConstructibleWith();
  });
});
