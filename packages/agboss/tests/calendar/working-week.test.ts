/**
 * #944 AC1: a working-hour deadline by the built-in weekly grid — Tel Aviv, Sunday to Thursday,
 * 09:00–18:00, lunch 13:00–14:00. Local times of Asia/Jerusalem are UTC+2 in winter. Every instant
 * is explicit; the machine's zone is never read.
 */
import { describe, expect, it, vi } from "vitest";
import { Weekday } from "../../src/index.js";
import { workMs } from "./units.js";
import { after, ALL_DAYS, HOUR, MINUTE, TEL_AVIV, WEEKDAYS, week } from "./helpers.js";

const tlv = week(TEL_AVIV);

describe("#944 AC1: the weekly grid", () => {
  it("AC1: Thursday 17:30 + 2 h → Sunday 10:30", async () => {
    // Thu 2026-01-08 17:30 IST = 15:30Z; Sun 2026-01-11 10:30 IST = 08:30Z
    expect(await after(tlv, "2026-01-08T15:30:00.000Z", 2 * HOUR)).toBe("2026-01-11T08:30:00.000Z");
  });

  it("AC1: 12:30 + 2 h across lunch → 15:30", async () => {
    // Sun 2026-01-11 12:30 IST = 10:30Z; 15:30 IST = 13:30Z
    expect(await after(tlv, "2026-01-11T10:30:00.000Z", 2 * HOUR)).toBe("2026-01-11T13:30:00.000Z");
  });

  it("AC1: a holiday is skipped", async () => {
    const withHoliday = week({ ...TEL_AVIV, holidays: ["2026-01-11"] });
    // Thu 17:30 + 2 h: 30 min Thursday, then Sunday is a holiday, Monday 09:00 + 1.5 h = 10:30 (08:30Z)
    expect(await after(withHoliday, "2026-01-08T15:30:00.000Z", 2 * HOUR)).toBe(
      "2026-01-12T08:30:00.000Z",
    );
  });

  it("AC1: asked inside a break starts at its end", async () => {
    // Sun 13:30 IST = 11:30Z, inside lunch; the clock starts at 14:00 (12:00Z)
    expect(await after(tlv, "2026-01-11T11:30:00.000Z", HOUR)).toBe("2026-01-11T13:00:00.000Z");
  });

  it("AC1: asked after hours starts the next working day", async () => {
    // Sun 19:00 IST = 17:00Z → Mon 09:00 IST (07:00Z) + 1 h
    expect(await after(tlv, "2026-01-11T17:00:00.000Z", HOUR)).toBe("2026-01-12T08:00:00.000Z");
  });

  it("AC1: asked on a non-working day (Friday) starts Sunday", async () => {
    // Fri 2026-01-09 12:00 IST = 10:00Z
    expect(await after(tlv, "2026-01-09T10:00:00.000Z", HOUR)).toBe("2026-01-11T08:00:00.000Z");
  });

  it("AC1: workingMinutes(1) at 17:59 ends at 18:00, the next at 09:01 the next day", async () => {
    // Sun 17:59 IST = 15:59Z; 18:00 IST = 16:00Z
    expect(await after(tlv, "2026-01-11T15:59:00.000Z", MINUTE)).toBe("2026-01-11T16:00:00.000Z");
    expect(await after(tlv, "2026-01-11T15:59:00.000Z", 2 * MINUTE)).toBe(
      "2026-01-12T07:01:00.000Z",
    );
  });

  it("AC1: a holiday on the start day", async () => {
    const withHoliday = week({ ...TEL_AVIV, holidays: ["2026-01-11"] });
    // Sun 10:00 IST (08:00Z) is a holiday: starts Monday 09:00 IST (07:00Z)
    expect(await after(withHoliday, "2026-01-11T08:00:00.000Z", HOUR)).toBe(
      "2026-01-12T08:00:00.000Z",
    );
  });

  it("AC1: a deadline exactly at the end of the working day is that end", async () => {
    // Sun 16:00 IST = 14:00Z, + 2 h = 18:00 IST = 16:00Z
    expect(await after(tlv, "2026-01-11T14:00:00.000Z", 2 * HOUR)).toBe("2026-01-11T16:00:00.000Z");
  });

  it("AC1: a long amount walks weeks: 45 working hours from Sunday 09:00", async () => {
    // 8 working hours a day, Sun–Thu: 45 h = 5 days (40 h) + 5 h — Sun 09:00 → next Sun 09:00 + 5 h,
    // lunch counted: 09:00–13:00 is 4 h, 14:00 is the 5th hour → 15:00
    expect(await after(tlv, "2026-01-11T07:00:00.000Z", 45 * HOUR)).toBe(
      "2026-01-18T13:00:00.000Z",
    );
  });

  it("AC1: a role in another time zone counts its own hours", async () => {
    const ny = week({
      timeZone: "America/New_York",
      days: WEEKDAYS,
      hours: [{ from: "09:00", to: "17:00" }],
    });
    // Fri 2026-01-09 16:00 EST = 21:00Z; + 2 h → Mon 2026-01-12 10:00 EST = 15:00Z
    expect(await after(ny, "2026-01-09T21:00:00.000Z", 2 * HOUR)).toBe("2026-01-12T15:00:00.000Z");
  });
});

describe("#944: dates the calendar has to count across", () => {
  const office = week({
    timeZone: "UTC",
    days: WEEKDAYS,
    hours: [{ from: "09:00", to: "17:00" }],
  });

  it("a leap day is a day: Monday 2028-02-28 16:00 + 2 h → Tuesday 2028-02-29 10:00", async () => {
    expect(await after(office, "2028-02-28T16:00:00.000Z", 2 * HOUR)).toBe(
      "2028-02-29T10:00:00.000Z",
    );
  });

  it("no leap day in 2026: Friday 02-27 16:00 + 2 h → Monday 03-02 10:00", async () => {
    expect(await after(office, "2026-02-27T16:00:00.000Z", 2 * HOUR)).toBe(
      "2026-03-02T10:00:00.000Z",
    );
  });

  it("a leap day listed as a holiday is skipped", async () => {
    const closed = week({
      timeZone: "UTC",
      days: WEEKDAYS,
      hours: [{ from: "09:00", to: "17:00" }],
      holidays: ["2028-02-29"],
    });
    expect(await after(closed, "2028-02-28T16:00:00.000Z", 2 * HOUR)).toBe(
      "2028-03-01T10:00:00.000Z",
    );
  });

  it("a deadline spanning the year end, New Year's Day a holiday", async () => {
    const closed = week({
      timeZone: "UTC",
      days: WEEKDAYS,
      hours: [{ from: "09:00", to: "17:00" }],
      holidays: ["2026-01-01"],
    });
    // Wed 2025-12-31 16:00 + 3 h: 1 h that day, then Thursday is a holiday, Friday 09:00 + 2 h
    expect(await after(closed, "2025-12-31T16:00:00.000Z", 3 * HOUR)).toBe(
      "2026-01-02T11:00:00.000Z",
    );
  });

  it("a Saturday-only week (days: one weekday) finds its day over the others", async () => {
    const saturdays = week({
      timeZone: "UTC",
      days: [Weekday.Saturday],
      hours: [{ from: "10:00", to: "12:00" }],
    });
    // Mon 2026-01-05 → Sat 2026-01-10 10:00 + 30 min
    expect(await after(saturdays, "2026-01-05T08:00:00.000Z", 30 * MINUTE)).toBe(
      "2026-01-10T10:30:00.000Z",
    );
  });

  it("holidays that empty several weeks of a one-day week are walked over", async () => {
    const saturdays = week({
      timeZone: "UTC",
      days: [Weekday.Saturday],
      hours: [{ from: "10:00", to: "12:00" }],
      holidays: ["2026-01-10", "2026-01-17", "2026-01-24"],
    });
    expect(await after(saturdays, "2026-01-05T08:00:00.000Z", HOUR)).toBe(
      "2026-01-31T11:00:00.000Z",
    );
  });

  it("a day of 24:00 hours is the whole local date", async () => {
    const round = week({
      timeZone: "Asia/Tokyo",
      days: ALL_DAYS,
      hours: [{ from: "00:00", to: "24:00" }],
    });
    // time is plain wall-clock time for a round-the-clock week
    expect(await after(round, "2026-06-01T00:00:00.000Z", 50 * HOUR)).toBe(
      "2026-06-03T02:00:00.000Z",
    );
  });

  it("a fractional amount rounds up to the next millisecond, never down", async () => {
    // 0.5 ms of working time from 09:00:00.000
    expect(await after(office, "2026-01-05T09:00:00.000Z", 0.5)).toBe("2026-01-05T09:00:00.001Z");
  });
});

describe("#944: the walk is bounded and fast", () => {
  const FIVE_YEARS = 5 * 366 * 24 * HOUR;
  const request = (amount: number) => ({
    from: new Date("2026-01-05T09:00:00.000Z"),
    amount: workMs(amount),
    tenantId: "default",
    target: "r",
  });

  it("a non-finite, NaN, zero or negative amount fails at once with a RangeError", () => {
    for (const bad of [Infinity, Number.NaN, 0, -5])
      expect(() => tlv.addWorkingTime(request(bad))).toThrow(RangeError);
  });

  it("an astronomically large amount fails fast past the day limit", () => {
    expect(() => tlv.addWorkingTime(request(1e300))).toThrow(/25 years/);
    expect(() => tlv.addWorkingTime(request(FIVE_YEARS * 4))).toThrow(RangeError);
  });

  it("a five-year working span computes in a bounded walk", async () => {
    const round = week({
      timeZone: "Europe/Berlin",
      days: ALL_DAYS,
      hours: [{ from: "00:00", to: "24:00" }],
    });
    expect(await after(round, "2026-01-05T09:00:00.000Z", FIVE_YEARS)).toBe(
      new Date(Date.parse("2026-01-05T09:00:00.000Z") + FIVE_YEARS).toISOString(),
    );
  });

  it("a holiday list covering years is walked, never looped for ever", async () => {
    const holidays: string[] = [];
    for (let day = 0; day < 1000; day += 1)
      holidays.push(new Date(Date.UTC(2026, 0, 6 + day)).toISOString().slice(0, 10));
    const closed = week({
      timeZone: "UTC",
      days: ALL_DAYS,
      hours: [{ from: "09:00", to: "17:00" }],
      holidays,
    });
    expect(await after(closed, "2026-01-05T09:00:00.000Z", HOUR)).toBe("2026-01-05T10:00:00.000Z");
    expect(await after(closed, "2026-01-05T16:30:00.000Z", HOUR)).toBe("2028-10-02T09:30:00.000Z");
  });

  it("a calendar with no working time at all is refused at start, never walked", () => {
    const none = week({ ...TEL_AVIV, days: [] });
    expect(() => none.addWorkingTime(request(HOUR))).toThrow(RangeError);
  });

  it("a normal office week (Mon–Fri 09:00–17:00) takes a five-year working span", async () => {
    const office = week({
      timeZone: "UTC",
      days: WEEKDAYS,
      hours: [{ from: "09:00", to: "17:00" }],
    });
    const end = await after(office, "2026-01-05T09:00:00.000Z", FIVE_YEARS);
    // 43,920 working hours at 40 a week: 1,098 weeks
    expect(Date.parse(end)).toBeGreaterThan(
      Date.parse("2026-01-05T09:00:00.000Z") + 1097 * 7 * 24 * HOUR,
    );
  });

  it("a one-hour-a-week calendar takes workingHours(800), and the cap still stops a runaway", async () => {
    const thin = week({
      timeZone: "UTC",
      days: [Weekday.Monday],
      hours: [{ from: "09:00", to: "10:00" }],
    });
    expect(await after(thin, "2026-01-05T09:00:00.000Z", 800 * HOUR)).toBe(
      "2041-04-29T10:00:00.000Z",
    );
    expect(() => thin.addWorkingTime(request(FIVE_YEARS * 100))).toThrow(/25 years/);
  });

  it("a one-minute-a-week grid and workingHours(43920): refused at once, never walked", () => {
    const sparse = week({
      timeZone: "Europe/Berlin",
      days: [Weekday.Monday],
      hours: [{ from: "09:00", to: "09:01" }],
    });
    const formats = vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts");
    const before = formats.mock.calls.length;
    expect(() => sparse.addWorkingTime(request(43_920 * HOUR))).toThrow(/25 years/);
    // no day was formatted: a walk would format thousands (the check counts the work, not the time)
    expect(formats.mock.calls.length - before).toBe(0);
    formats.mockRestore();
  });

  it("a holiday list covering twenty years is walked within the hard cap", async () => {
    const holidays: string[] = [];
    for (let day = 0; day < 7305; day += 1)
      holidays.push(new Date(Date.UTC(2026, 0, 6 + day)).toISOString().slice(0, 10));
    const closed = week({
      timeZone: "UTC",
      days: ALL_DAYS,
      hours: [{ from: "09:00", to: "17:00" }],
      holidays,
    });
    expect(await after(closed, "2026-01-05T16:30:00.000Z", HOUR)).toBe("2046-01-06T09:30:00.000Z");
  });
});
