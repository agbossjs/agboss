import { describe, expect, it } from "vitest";
import {
  bytes,
  days,
  gb,
  hours,
  isWorkingDuration,
  kb,
  kilobytes,
  mb,
  megabytes,
  min,
  minutes,
  ms,
  sec,
  seconds,
  tb,
  workDays,
  workHours,
  workingHours,
  workingMinutes,
  workMin,
} from "../../src/units/index.js";
import { ConfigError } from "../../src/core/error-families/config-errors.js";

/** #1314b-add: the concise names next to the old ones; each gives the same value as its old helper. */
describe("#1314b-add: concise units", () => {
  it("bytes", () => {
    expect(bytes(512)).toBe(512);
    expect(kb(64)).toBe(kilobytes(64));
    expect(mb(5)).toBe(megabytes(5));
    expect(mb(1)).toBe(1_048_576);
    expect(gb(1)).toBe(1_073_741_824);
    expect(tb(1)).toBe(1_099_511_627_776);
  });

  it("durations", () => {
    expect(ms(250)).toBe(250);
    expect(sec(30)).toBe(seconds(30));
    expect(min(5)).toBe(minutes(5));
    expect(hours(2)).toBe(7_200_000);
    expect(days(7)).toBe(604_800_000);
  });

  it("working time", () => {
    expect(workMin(30)).toEqual(workingMinutes(30));
    expect(workHours(2)).toEqual(workingHours(2));
    expect(isWorkingDuration(workDays(2))).toBe(true);
  });

  it("a negative or non-finite amount is a ConfigError.Unit naming the unit", () => {
    expect(() => kb(-1)).toThrow(ConfigError.Unit);
    expect(() => sec(Number.NaN)).toThrow("sec must be a finite number ≥ 0");
    expect(() => workMin(0)).toThrow("workMin must be a positive finite number");
    expect(() => days(Number.POSITIVE_INFINITY)).toThrow(ConfigError.Unit);
  });
});
