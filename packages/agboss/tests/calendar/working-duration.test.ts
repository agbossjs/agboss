/**
 * #944: `workingHours(n)` / `workingMinutes(n)` — working time as a value (a positive finite number,
 * `RangeError` otherwise, as `hours()`), told from plain time, written in messages and in the printed
 * flow; the helpers every rule shares.
 */
import { describe, expect, it } from "vitest";
import {
  UnitError,
  hours,
  isWorkingDuration,
  minutes,
  workingHours,
  workingMinutes,
} from "../../src/units/index.js";
import { durationLabel, spanLabel } from "../../src/units/duration-label.js";
import { amountOf, isSameSpan, spanText } from "../../src/units/working-time.js";
import { isExpiresIn, isRemindBefore } from "../../src/channels/channel-rules.js";

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

  it("a positive finite number, else RangeError (UnitError)", () => {
    for (const bad of [0, -1, Number.NaN, Infinity, -Infinity]) {
      expect(() => workingHours(bad)).toThrow(RangeError);
      expect(() => workingMinutes(bad)).toThrow(UnitError);
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
    Object.freeze({ [Symbol.for("agboss.units.working-duration")]: amount });

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
