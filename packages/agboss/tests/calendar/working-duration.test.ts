/**
 * #944: `workingHours(n)` / `workingMinutes(n)` — working time as a value (a positive finite number,
 * `RangeError` otherwise, as `hours()`), told from plain time, written in messages and in the printed
 * flow; the helpers every rule shares.
 */
import { describe, expect, it } from "vitest";
import {
  hours,
  isWorkingDuration,
  minutes,
  workDays,
  workHours,
  workingHours,
  workingMinutes,
} from "../../src/units/index.js";
import { durationLabel, spanLabel } from "../../src/units/duration-label.js";
import { amountOf, isSameSpan, spanText, unitOf } from "../../src/units/working-time.js";
import { isExpiresIn, isRemindBefore } from "../../src/channels/channel-rules.js";
import { ConfigError } from "../../src/core/error-families/config-errors.js";

describe("#944: workingHours and workingMinutes", () => {
  it("are working durations holding their amount in milliseconds", () => {
    expect(isWorkingDuration(workingHours(2))).toBe(true);
    expect(amountOf(workingHours(2))).toBe(7_200_000);
    expect(amountOf(workingMinutes(90))).toBe(5_400_000);
    expect(amountOf(workingHours(0.5))).toBe(1_800_000);
  });

  it("are not plain durations: a number is no working duration, a working one is no number", () => {
    expect(isWorkingDuration(hours(2))).toBe(false);
    expect(isWorkingDuration(7_200_000)).toBe(false);
    expect(isWorkingDuration(undefined)).toBe(false);
    expect(isWorkingDuration(null)).toBe(false);
    expect(isWorkingDuration({})).toBe(false);
    expect(typeof workingHours(2)).toBe("object");
    expect(Object.isFrozen(workingHours(2))).toBe(true);
  });

  it("a positive finite number, else ConfigError.Unit", () => {
    for (const bad of [0, -1, Number.NaN, Infinity, -Infinity]) {
      expect(() => workingHours(bad)).toThrow(ConfigError.Unit);
      expect(() => workingMinutes(bad)).toThrow(ConfigError.Unit);
    }
    expect(() => workingHours(0)).toThrow("workingHours must be a positive finite number, got 0");
  });

  it("the same kind and amount are the same span; plain and working never are", () => {
    expect(isSameSpan(workingHours(2), workingHours(2))).toBe(true);
    expect(isSameSpan(workingHours(2), workingMinutes(120))).toBe(true);
    expect(isSameSpan(workingHours(2), workingHours(3))).toBe(false);
    expect(isSameSpan(workingHours(2), hours(2))).toBe(false);
    expect(isSameSpan(hours(2), hours(2))).toBe(true);
    expect(isSameSpan(undefined, undefined)).toBe(true);
    expect(isSameSpan(undefined, hours(2))).toBe(false);
    expect(isSameSpan(hours(2), undefined)).toBe(false);
  });

  it("a deadline and a reminder accept working time (a deadline at least seconds(1))", () => {
    expect(isExpiresIn(workingHours(2))).toBe(true);
    expect(isExpiresIn(workingMinutes(1 / 60))).toBe(true);
    expect(isExpiresIn(workingMinutes(0.01))).toBe(false);
    expect(isExpiresIn({ working: 1 })).toBe(false);
    expect(isRemindBefore(workingMinutes(0.01))).toBe(true);
    expect(isRemindBefore(minutes(5))).toBe(true);
    expect(isRemindBefore(0)).toBe(false);
  });

  it("are written in messages and labels as working time", () => {
    expect(spanText(workingHours(2))).toBe("7200000 ms of working time");
    expect(spanText(hours(2))).toBe("7200000");
    expect(spanLabel(workingHours(2))).toBe("2 h of working time");
    expect(spanLabel(hours(2))).toBe(durationLabel(7_200_000));
    expect(spanLabel(workingMinutes(90))).toBe("90 min of working time");
  });
});

describe("#944: spans are bounded (a config value or an extension cannot walk the calendar for ever)", () => {
  const FIVE_YEARS = 5 * 366 * 24 * 3_600_000;
  const forged = (amount: number): unknown =>
    Object.freeze({ [Symbol.for("agboss.units.working-duration")]: true, unit: "ms", amount });

  it.each([Infinity, -Infinity, Number.NaN, -1, 0, 1e300, FIVE_YEARS + 1])(
    "%s is no deadline and no reminder, plain or working",
    (amount) => {
      expect(isExpiresIn(forged(amount))).toBe(false);
      expect(isRemindBefore(forged(amount))).toBe(false);
      expect(isExpiresIn(amount)).toBe(false);
      expect(isRemindBefore(amount)).toBe(false);
    },
  );

  it("exactly five years is the longest", () => {
    expect(isExpiresIn(FIVE_YEARS)).toBe(true);
    expect(isExpiresIn(forged(FIVE_YEARS))).toBe(true);
  });
});

describe("#1310b: workDays counts working days, not hours", () => {
  it("is a working duration of days: { unit: 'days', amount }, never milliseconds", () => {
    expect(isWorkingDuration(workDays(2))).toBe(true);
    expect(workDays(2)).toMatchObject({ unit: "days", amount: 2 });
    expect(workHours(2)).toMatchObject({ unit: "ms", amount: 7_200_000 });
    expect(unitOf(workDays(2))).toBe("days");
    expect(unitOf(workHours(2))).toBe("ms");
    expect(unitOf(hours(2))).toBe("ms");
    expect(amountOf(workDays(1.5))).toBe(1.5);
  });

  it("is told from the same amount of hours, and from plain days", () => {
    expect(isSameSpan(workDays(2), workDays(2))).toBe(true);
    expect(isSameSpan(workDays(1), workHours(24))).toBe(false);
    expect(isSameSpan(workDays(1), workHours(1))).toBe(false);
  });

  it("is written in messages as working days", () => {
    expect(spanText(workDays(2))).toBe("2 working days");
    expect(spanLabel(workDays(2))).toBe("2 working days");
    expect(spanLabel(workDays(0.5))).toBe("0.5 working days");
  });

  it("a positive finite number, else ConfigError.Unit", () => {
    for (const bad of [0, -1, Number.NaN, Infinity])
      expect(() => workDays(bad)).toThrow(ConfigError.Unit);
    expect(() => workDays(0)).toThrow("workDays must be a positive finite number, got 0");
  });

  it("a deadline is a positive count of days up to five years of them; any fraction of a day will do", () => {
    expect(isExpiresIn(workDays(1))).toBe(true);
    expect(isExpiresIn(workDays(0.001))).toBe(true);
    expect(isExpiresIn(workDays(5 * 366))).toBe(true);
    expect(isExpiresIn(workDays(5 * 366 + 1))).toBe(false);
    expect(isRemindBefore(workDays(0.5))).toBe(true);
    expect(isRemindBefore(workDays(5 * 366 + 1))).toBe(false);
  });

  it("a forged working duration with no unit or amount is no working duration", () => {
    const brand = Symbol.for("agboss.units.working-duration");

    expect(isWorkingDuration({ [brand]: true })).toBe(false);
    expect(isWorkingDuration({ [brand]: true, unit: "weeks", amount: 1 })).toBe(false);
    expect(isWorkingDuration({ [brand]: true, unit: "days", amount: "1" })).toBe(false);
    expect(isWorkingDuration({ unit: "days", amount: 1 })).toBe(false);
    expect(isExpiresIn({ [brand]: true, unit: "days", amount: Number.NaN })).toBe(false);
  });
});
