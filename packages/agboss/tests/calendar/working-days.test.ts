/**
 * #1310b: `workDays(n)` counts working days of the resolved schedule, not 24 hours. A working day is
 * one local date with working time, whatever the length of its shifts; a date with none (a weekend,
 * a holiday) is skipped; a start in the middle of a shift counts the rest of that day in
 * proportion, and a fractional last day advances `ceil(share × the day's working milliseconds)`.
 * Every case states its UTC instants by hand.
 */
import { describe, expect, it } from "vitest";
import { Weekday } from "../../src/index.js";
import { workDays, workHours, workMin } from "../../src/units/index.js";
import { afterWork, ALL_DAYS, WEEKDAYS, week } from "./helpers.js";

/** Monday to Friday, 09:00–17:00 UTC: an 8-hour working day. */
const OFFICE = { timeZone: "UTC", days: WEEKDAYS, hours: [{ from: "09:00", to: "17:00" }] };

describe("#1310b: workDays on a weekly grid", () => {
  const office = week(OFFICE);

  it.each([
    [
      "one day from the start of a shift ends with it",
      "2026-01-05T09:00:00.000Z",
      1,
      "2026-01-05T17:00:00.000Z",
    ],
    [
      "two days end with the second shift",
      "2026-01-05T09:00:00.000Z",
      2,
      "2026-01-06T17:00:00.000Z",
    ],
    ["five days are the working week", "2026-01-05T09:00:00.000Z", 5, "2026-01-09T17:00:00.000Z"],
    ["six days skip the weekend", "2026-01-05T09:00:00.000Z", 6, "2026-01-12T17:00:00.000Z"],
    [
      "from a Friday evening the next day is Monday",
      "2026-01-09T17:00:00.000Z",
      1,
      "2026-01-12T17:00:00.000Z",
    ],
    [
      "from a Saturday the next day is Monday",
      "2026-01-10T12:00:00.000Z",
      1,
      "2026-01-12T17:00:00.000Z",
    ],
    [
      "from before the shift the whole day counts",
      "2026-01-05T03:00:00.000Z",
      1,
      "2026-01-05T17:00:00.000Z",
    ],
  ])("%s", async (_name, from, days, expected) => {
    expect(await afterWork(office, from, workDays(days))).toBe(expected);
  });

  it("a start in the middle of a shift counts the rest of that day in proportion", async () => {
    // Monday 13:00 leaves 4 of 8 hours: half a day, so one day is the same time tomorrow
    expect(await afterWork(office, "2026-01-05T13:00:00.000Z", workDays(1))).toBe(
      "2026-01-06T13:00:00.000Z",
    );
    expect(await afterWork(office, "2026-01-05T13:00:00.000Z", workDays(0.5))).toBe(
      "2026-01-05T17:00:00.000Z",
    );
    expect(await afterWork(office, "2026-01-05T13:00:00.000Z", workDays(2))).toBe(
      "2026-01-07T13:00:00.000Z",
    );
  });

  it("a fractional last day advances that share of its working milliseconds", async () => {
    expect(await afterWork(office, "2026-01-05T09:00:00.000Z", workDays(0.25))).toBe(
      "2026-01-05T11:00:00.000Z",
    );
    expect(await afterWork(office, "2026-01-05T09:00:00.000Z", workDays(1.5))).toBe(
      "2026-01-06T13:00:00.000Z",
    );
    // a share that does not divide the day rounds the advance up to the next millisecond
    expect(await afterWork(office, "2026-01-05T09:00:00.000Z", workDays(1 / 3))).toBe(
      "2026-01-05T11:40:00.000Z",
    );
  });

  it("is a day of the schedule, not 24 working hours (the placeholder it replaces)", async () => {
    const days = await afterWork(office, "2026-01-05T09:00:00.000Z", workDays(1));
    const hours24 = await afterWork(office, "2026-01-05T09:00:00.000Z", workHours(24));

    expect(days).toBe("2026-01-05T17:00:00.000Z");
    // 24 working hours are three of this schedule's days
    expect(hours24).toBe("2026-01-07T17:00:00.000Z");
  });

  it("a holiday is no working day", async () => {
    const withHoliday = week({ ...OFFICE, holidays: ["2026-01-06"] });

    expect(await afterWork(withHoliday, "2026-01-05T09:00:00.000Z", workDays(2))).toBe(
      "2026-01-07T17:00:00.000Z",
    );
  });

  it("isHoliday is a holiday rule asked for each local date", async () => {
    const asked: string[] = [];
    const byRule = week({
      ...OFFICE,
      isHoliday: (date) => {
        asked.push(date);
        return date === "2026-01-06";
      },
    });

    expect(await afterWork(byRule, "2026-01-05T09:00:00.000Z", workDays(2))).toBe(
      "2026-01-07T17:00:00.000Z",
    );
    expect(asked).toContain("2026-01-06");
  });

  it("a day's length is its own: breaks and split shifts make no day longer or shorter", async () => {
    const split = week({
      timeZone: "UTC",
      days: ALL_DAYS,
      hours: [
        { from: "08:00", to: "12:00" },
        { from: "20:00", to: "24:00" },
      ],
    });

    expect(await afterWork(split, "2026-01-05T08:00:00.000Z", workDays(1))).toBe(
      "2026-01-06T00:00:00.000Z",
    );
    expect(await afterWork(split, "2026-01-05T08:00:00.000Z", workDays(0.5))).toBe(
      "2026-01-05T12:00:00.000Z",
    );
  });

  it("working minutes and hours are unchanged: they count real working time", async () => {
    expect(await afterWork(office, "2026-01-05T16:30:00.000Z", workMin(45))).toBe(
      "2026-01-06T09:15:00.000Z",
    );
  });
});

describe("#1310b: workDays on the days the clocks change", () => {
  // Berlin, a shift 01:00–04:00 local on every day
  const NIGHT = {
    timeZone: "Europe/Berlin",
    days: ALL_DAYS,
    hours: [{ from: "01:00", to: "04:00" }],
  };
  const night = week(NIGHT);

  it("a spring-forward day is short (2 real hours) but still one day", async () => {
    // 2026-03-29: 01:00 CET = 00:00Z, the gap 02:00–03:00 has no instants, 04:00 CEST = 02:00Z
    expect(await afterWork(night, "2026-03-28T23:00:00.000Z", workDays(1))).toBe(
      "2026-03-29T02:00:00.000Z",
    );
    // from the middle of the short day: 1 of its 2 hours left is half a day; the other half of one
    // day is half of Monday's 3 hours
    expect(await afterWork(night, "2026-03-29T01:00:00.000Z", workDays(1))).toBe(
      "2026-03-30T00:30:00.000Z",
    );
  });

  it("a fall-back day is long (4 real hours): one day, its whole length", async () => {
    // 2026-10-25: 01:00 CEST = 23:00Z (24th) … 04:00 CET = 03:00Z
    expect(await afterWork(night, "2026-10-24T22:00:00.000Z", workDays(1))).toBe(
      "2026-10-25T03:00:00.000Z",
    );
    expect(await afterWork(night, "2026-10-24T22:00:00.000Z", workDays(0.5))).toBe(
      "2026-10-25T01:00:00.000Z",
    );
  });

  it("two days across the change are two dates, however long each is", async () => {
    // Sat 28 (3 h) + Sun 29 (2 h): ends with Sunday's shift
    expect(await afterWork(night, "2026-03-28T00:00:00.000Z", workDays(2))).toBe(
      "2026-03-29T02:00:00.000Z",
    );
  });
});

describe("#1310b: workDays in a zone not at UTC", () => {
  it("counts the local dates of the grid's zone: a Tel Aviv Sunday is a working day", async () => {
    const telAviv = week({
      timeZone: "Asia/Jerusalem",
      days: [Weekday.Sunday, Weekday.Monday, Weekday.Tuesday, Weekday.Wednesday, Weekday.Thursday],
      hours: [{ from: "09:00", to: "18:00" }],
      breaks: [{ from: "13:00", to: "14:00" }],
    });

    // Thursday 2026-01-08 09:00 IST = 07:00Z; one day later is Sunday: 18:00 IST = 16:00Z
    expect(await afterWork(telAviv, "2026-01-08T07:00:00.000Z", workDays(1))).toBe(
      "2026-01-08T16:00:00.000Z",
    );
    expect(await afterWork(telAviv, "2026-01-08T07:00:00.000Z", workDays(2))).toBe(
      "2026-01-11T16:00:00.000Z",
    );
  });
});
