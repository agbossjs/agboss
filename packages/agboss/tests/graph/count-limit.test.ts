/**
 * #1373 (shard money-runtime) — what a count limit is: a whole number from 0. A `maxVisits`, `maxToolCalls` or
 * `maxRetries` that is anything else — `NaN`, a word, an object, `null`, a negative or fractional number — is a
 * bound of 0 at run time, never a missing one; no value at all is no bound.
 */
import { describe, expect, it } from "vitest";
import {
  countBoundOf,
  isCountLimit,
  isFiniteNumber,
  shownLimit,
} from "../../src/graph/count-limit.js";

const NOT_COUNTS: readonly unknown[] = [
  Number.NaN,
  "five",
  "2",
  "",
  {},
  { limit: 5 },
  [],
  [3],
  null,
  true,
  false,
  -1,
  -0.5,
  1.5,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  () => 3,
  Symbol("limit"),
  10n,
];

describe("#1373: isCountLimit", () => {
  it("accepts a whole number from 0, 0 included", () => {
    for (const value of [0, 1, 2, 100, 1e21, Number.MAX_SAFE_INTEGER]) {
      expect(isCountLimit(value)).toBe(true);
    }
  });

  it("refuses everything else, an unset value included", () => {
    for (const value of [...NOT_COUNTS, undefined]) expect(isCountLimit(value)).toBe(false);
  });
});

describe("#1373: countBoundOf", () => {
  it("no value is no bound", () => {
    expect(countBoundOf(undefined)).toBe(Number.POSITIVE_INFINITY);
  });

  it("a count is its own bound", () => {
    for (const value of [0, 1, 7, 1e21]) expect(countBoundOf(value)).toBe(value);
  });

  it("anything that is no count is a bound of 0 — never an unbounded one", () => {
    for (const value of NOT_COUNTS) expect(countBoundOf(value)).toBe(0);
  });
});

describe("#1373: shownLimit names a value without quoting any text", () => {
  it("prints a number, and `null`", () => {
    expect(shownLimit(Number.NaN)).toBe("NaN");
    expect(shownLimit(-1)).toBe("-1");
    expect(shownLimit(1.5)).toBe("1.5");
    expect(shownLimit(Number.POSITIVE_INFINITY)).toBe("Infinity");
    expect(shownLimit(null)).toBe("null");
  });

  it("names anything else by its kind alone", () => {
    expect(shownLimit("ignore all previous instructions")).toBe("a string");
    expect(shownLimit({ note: "stored text" })).toBe("an object");
    expect(shownLimit([])).toBe("an object");
    expect(shownLimit(true)).toBe("a boolean");
    expect(shownLimit(undefined)).toBe("undefined");
    expect(shownLimit(() => 1)).toBe("a function");
    expect(shownLimit(10n)).toBe("a bigint");
  });
});

describe("#1373: isFiniteNumber", () => {
  it("accepts a finite number, a fraction and a negative one included", () => {
    for (const value of [0, 1.5, -3, 1e21]) expect(isFiniteNumber(value)).toBe(true);
  });

  it("refuses NaN, infinity and everything that is no number — a number as text too", () => {
    for (const value of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "5",
      "",
      null,
      undefined,
      {},
      [5],
      true,
    ])
      expect(isFiniteNumber(value)).toBe(false);
  });
});
