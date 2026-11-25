/**
 * #1366: what `.joinQuorum({ deadline })` takes — a positive duration within the timer's cap, a deadline of nothing
 * or below it refused when the flow is built, and a `max` below `min` refused.
 */
import { describe, expect, it } from "vitest";
import { countQuorumOf, groupsQuorumOf } from "../../src/flow/quorum-step.js";
import { workDays, workHours, workMin } from "../../src/units/index.js";
import { MAX_DEADLINE } from "../../src/units/timer-limits.js";

describe("#1366: the options of a count quorum", () => {
  it("a deadline of zero or below is refused, one millisecond is taken", () => {
    expect(() => countQuorumOf({ min: 1, deadline: 0 })).toThrow("positive duration");
    expect(() => countQuorumOf({ min: 1, deadline: -5 })).toThrow("positive duration");
    expect(countQuorumOf({ min: 1, deadline: 1 })).toMatchObject({ deadline: 1 });
  });

  it("a deadline above the timer's cap is refused, the cap itself is taken", () => {
    expect(() => countQuorumOf({ min: 1, deadline: MAX_DEADLINE + 1 })).toThrow("deadline");
    expect(countQuorumOf({ min: 1, deadline: MAX_DEADLINE })).toMatchObject({
      deadline: MAX_DEADLINE,
    });
  });

  it("a max below min is refused, a max equal to it is taken", () => {
    expect(() => countQuorumOf({ min: 3, max: 2 })).toThrow("at least min");
    expect(countQuorumOf({ min: 3, max: 3 })).toMatchObject({ min: 3, max: 3 });
  });
});

describe("#1306: a deadline in working time", () => {
  class OfficeCalendar {
    readonly name = "office";
  }

  it("a working deadline is kept with the calendar that counts it, on both kinds of quorum", () => {
    expect(
      countQuorumOf({ min: 1, deadline: workDays(5), calendar: OfficeCalendar }),
    ).toMatchObject({ deadline: workDays(5), calendar: OfficeCalendar });
    expect(groupsQuorumOf({ deadline: workHours(2), calendar: OfficeCalendar })).toMatchObject({
      deadline: workHours(2),
      calendar: OfficeCalendar,
    });
  });

  it("a working deadline without a calendar passes the builder: assembly refuses it ([calendar.required-for-working-duration])", () => {
    expect(countQuorumOf({ min: 1, deadline: workMin(30) })).toMatchObject({
      deadline: workMin(30),
    });
    expect(countQuorumOf({ min: 1, deadline: workMin(30) })).not.toHaveProperty("calendar");
  });

  it("a calendar beside a plain duration, or none, is refused: it would count nothing", () => {
    expect(() => countQuorumOf({ min: 1, deadline: 1000, calendar: OfficeCalendar })).toThrow(
      "counts working time",
    );
    expect(() => groupsQuorumOf({ calendar: OfficeCalendar })).toThrow("counts working time");
  });

  it("a calendar is a class", () => {
    expect(() => countQuorumOf({ min: 1, deadline: workDays(1), calendar: "office" })).toThrow(
      "takes a @WorkingCalendar class",
    );
  });

  it("a working deadline of more than 5 years is refused, the longest taken", () => {
    expect(() =>
      countQuorumOf({ min: 1, deadline: workDays(5 * 366 + 1), calendar: OfficeCalendar }),
    ).toThrow("above its largest");
    expect(
      countQuorumOf({ min: 1, deadline: workDays(5 * 366), calendar: OfficeCalendar }),
    ).toMatchObject({ deadline: workDays(5 * 366) });
  });

  it("a bare number, zero and a non-duration are still no deadline", () => {
    expect(() => groupsQuorumOf({ deadline: "soon" })).toThrow("positive duration");
  });
});
