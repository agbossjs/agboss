/**
 * #1310b: `WorkingWeek.anyOf(schedules)`: a pool in several zones, any of whom may answer. Working
 * milliseconds are counted over the union of the schedules (overlapping hours once); working days
 * are the earliest of each schedule's own count, in its own zone.
 */
import { describe, expect, it } from "vitest";
import { WorkingWeek, type WorkingCalendarHandler } from "../../src/index.js";
import { workDays, workHours } from "../../src/units/index.js";
import { isWorkingWeek, workingWeekProblemsOf } from "../../src/calendar/working-week.js";
import { afterWork, WEEKDAYS, week } from "./helpers.js";

const grid = (timeZone: string, from: string, to: string): WorkingCalendarHandler =>
  week({ timeZone, days: WEEKDAYS, hours: [{ from, to }] });

describe("#1310b: WorkingWeek.anyOf, working hours", () => {
  const london = grid("UTC", "09:00", "17:00");
  const tokyo = grid("Asia/Tokyo", "09:00", "17:00"); // 00:00–08:00Z

  it("works whenever any schedule works", async () => {
    const pool = WorkingWeek.anyOf([london, tokyo]);

    // Monday 00:00Z: Tokyo's whole shift (8 h) ends at 08:00Z, the 9th hour is London's first
    expect(await afterWork(pool, "2026-01-05T00:00:00.000Z", workHours(8))).toBe(
      "2026-01-05T08:00:00.000Z",
    );
    expect(await afterWork(pool, "2026-01-05T00:00:00.000Z", workHours(9))).toBe(
      "2026-01-05T10:00:00.000Z",
    );
  });

  it("counts overlapping hours once, adjacent hours as one stretch", async () => {
    const pool = WorkingWeek.anyOf([grid("UTC", "09:00", "17:00"), grid("UTC", "13:00", "21:00")]);

    // the union is 09:00–21:00, 12 hours: 4 hours of overlap are not counted twice
    expect(await afterWork(pool, "2026-01-05T09:00:00.000Z", workHours(12))).toBe(
      "2026-01-05T21:00:00.000Z",
    );
    expect(await afterWork(pool, "2026-01-05T09:00:00.000Z", workHours(13))).toBe(
      "2026-01-06T10:00:00.000Z",
    );
  });

  it("one schedule is that schedule; the order of schedules does not matter", async () => {
    const from = "2026-01-05T10:00:00.000Z";
    const alone = await afterWork(WorkingWeek.anyOf([london]), from, workHours(20));

    expect(alone).toBe(await afterWork(london, from, workHours(20)));
    expect(await afterWork(WorkingWeek.anyOf([london, tokyo]), from, workHours(20))).toBe(
      await afterWork(WorkingWeek.anyOf([tokyo, london]), from, workHours(20)),
    );
  });

  it("nests: an anyOf of anyOf is the union of all", async () => {
    const nested = WorkingWeek.anyOf([WorkingWeek.anyOf([london]), WorkingWeek.anyOf([tokyo])]);

    expect(await afterWork(nested, "2026-01-05T00:00:00.000Z", workHours(9))).toBe(
      "2026-01-05T10:00:00.000Z",
    );
  });
});

describe("#1310b: WorkingWeek.anyOf, working days", () => {
  it("is the earliest of each schedule's own count: no shift is split at 00:00Z", async () => {
    const pool = WorkingWeek.anyOf([
      grid("UTC", "09:00", "17:00"),
      grid("Asia/Tokyo", "09:00", "17:00"),
    ]);

    // Tokyo's Monday (Jan 5 local) ends at 08:00Z; London's Monday ends at 17:00Z
    expect(await afterWork(pool, "2026-01-05T00:00:00.000Z", workDays(1))).toBe(
      "2026-01-05T08:00:00.000Z",
    );
    // two days: Tokyo's Tuesday ends 2026-01-06T08:00Z
    expect(await afterWork(pool, "2026-01-05T00:00:00.000Z", workDays(2))).toBe(
      "2026-01-06T08:00:00.000Z",
    );
  });

  it("a schedule that cannot answer is left out while another can", async () => {
    const never = week({ timeZone: "UTC", days: [], hours: [{ from: "09:00", to: "17:00" }] });
    const pool = WorkingWeek.anyOf([never, grid("UTC", "09:00", "17:00")]);

    expect(workingWeekProblemsOf(pool)).toHaveLength(1);
  });
});

describe("#1310b: WorkingWeek.anyOf, what is invalid", () => {
  it("nothing to choose from is a problem the assembly reports, and the walk refuses", () => {
    const none = WorkingWeek.anyOf([]);

    expect(isWorkingWeek(none)).toBe(true);
    expect(workingWeekProblemsOf(none)).toEqual(["anyOf takes at least one schedule"]);
    expect(() =>
      none.addWorkingTime({
        from: new Date("2026-01-05T09:00:00.000Z"),
        amount: workHours(1),
        tenantId: "default",
      }),
    ).toThrow(/no working time ahead/);
  });

  it("an invalid schedule is named by its place; a calendar of the project's own is no schedule", () => {
    const bad = week({
      timeZone: "Mars/Olympus",
      days: WEEKDAYS,
      hours: [{ from: "09:00", to: "17:00" }],
    });
    const own: WorkingCalendarHandler = { addWorkingTime: () => new Date() };

    expect(
      workingWeekProblemsOf(WorkingWeek.anyOf([grid("UTC", "09:00", "17:00"), bad]))[0],
    ).toMatch(/^schedule 1: timeZone/);
    expect(workingWeekProblemsOf(WorkingWeek.anyOf([own]))[0]).toMatch(
      /^schedule 0 is no WorkingWeek/,
    );
  });
});
