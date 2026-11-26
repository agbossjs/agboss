/**
 * #1307 (G3, Q-A): a pause's times are `Date`s, and `===` on two `Date`s compares references. The
 * helpers every compare-and-set, ceiling and due check goes through compare instants; these properties
 * hold over any millisecond, and the table pins what the naive operators get wrong.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { earlierOf, isBefore, sameInstant } from "../../src/infrastructure/instants.js";
import {
  compareText,
  earlierText,
  instantOf,
  isBeforeText,
  isDueAt,
  sameInstantText,
} from "../../src/infrastructure/pause-record-instants.js";

/** Any instant a `Date` can hold, to the millisecond. */
const millis = fc.integer({ min: -8_640_000_000_000_000, max: 8_640_000_000_000_000 });
const near = fc.integer({ min: 1_700_000_000_000, max: 1_900_000_000_000 });
const SEED = { seed: 1_307_000, numRuns: 500 } as const;

describe("sameInstant (#1307)", () => {
  it("two Date objects of one millisecond are the same instant, though never ===", () => {
    fc.assert(
      fc.property(millis, (ms) => {
        const a = new Date(ms);
        const b = new Date(ms);
        expect(a === b).toBe(false);
        expect(sameInstant(a, b)).toBe(true);
      }),
      SEED,
    );
  });

  it("is symmetric, and two different milliseconds are never the same", () => {
    fc.assert(
      fc.property(near, near, (x, y) => {
        const a = new Date(x);
        const b = new Date(y);
        expect(sameInstant(a, b)).toBe(sameInstant(b, a));
        expect(sameInstant(a, b)).toBe(x === y);
      }),
      SEED,
    );
  });

  it("an absent time is the same as another absent one and as no Date at all", () => {
    expect(sameInstant(undefined, undefined)).toBe(true);
    fc.assert(
      fc.property(millis, (ms) => {
        expect(sameInstant(new Date(ms), undefined)).toBe(false);
        expect(sameInstant(undefined, new Date(ms))).toBe(false);
      }),
      SEED,
    );
  });

  it("an invalid Date is the same as nothing: a compare-and-set over it never wins", () => {
    const invalid = new Date(Number.NaN);
    expect(sameInstant(invalid, invalid)).toBe(false);
    expect(sameInstant(invalid, new Date(0))).toBe(false);
    expect(sameInstant(invalid, undefined)).toBe(false);
  });
});

describe("isBefore and earlierOf (#1307)", () => {
  it("isBefore is a strict order: irreflexive, asymmetric, by milliseconds", () => {
    fc.assert(
      fc.property(near, near, (x, y) => {
        const a = new Date(x);
        const b = new Date(y);
        expect(isBefore(a, a)).toBe(false);
        expect(isBefore(a, b)).toBe(x < y);
        expect(isBefore(a, b) && isBefore(b, a)).toBe(false);
      }),
      SEED,
    );
  });

  it("earlierOf is the smaller instant, and the first argument on a tie", () => {
    fc.assert(
      fc.property(near, near, (x, y) => {
        const a = new Date(x);
        const b = new Date(y);
        const earlier = earlierOf(a, b);
        expect(earlier.getTime()).toBe(Math.min(x, y));
        expect(earlier).toBe(y < x ? b : a);
      }),
      SEED,
    );
  });
});

describe("the texts a record keeps, compared by instant (#1307, until the record is typed)", () => {
  it("the same instant in another spelling is the same instant, though not the same text", () => {
    const spellings = [
      "2026-01-05T09:00:00.000Z",
      "2026-01-05T09:00:00Z",
      "2026-01-05T11:00:00+02:00",
    ];
    for (const a of spellings)
      for (const b of spellings) {
        expect(sameInstantText(a, b)).toBe(true);
        expect(isBeforeText(a, b)).toBe(false);
        expect(compareText(a, b)).toBe(0);
      }
    const [exact, bare] = spellings;
    expect(exact === bare).toBe(false);
  });

  it("an earlier instant sorts before a later one whatever the zone says: +02:00 09:00 is 07:00Z", () => {
    expect(isBeforeText("2026-01-05T09:00:00+02:00", "2026-01-05T08:00:00.000Z")).toBe(true);
    // as texts, "09…" > "08…": the order of the texts is the wrong one
    const textBefore = (a: string, b: string): boolean => a < b;
    expect(textBefore("2026-01-05T09:00:00+02:00", "2026-01-05T08:00:00.000Z")).toBe(false);
    expect(earlierText("2026-01-05T09:00:00+02:00", "2026-01-05T08:00:00.000Z")).toBe(
      "2026-01-05T09:00:00+02:00",
    );
  });

  it("earlierText picks the earlier of the two wherever it stands", () => {
    const early = "2026-01-05T08:00:00.000Z";
    const late = "2026-01-05T09:00:00.000Z";
    expect(earlierText(early, late)).toBe(early);
    expect(earlierText(late, early)).toBe(early);
  });

  it("earlierText keeps its first argument on a tie, and an absent time equals only an absent one", () => {
    expect(earlierText("2026-01-05T09:00:00.000Z", "2026-01-05T09:00:00Z")).toBe(
      "2026-01-05T09:00:00.000Z",
    );
    expect(sameInstantText(undefined, undefined)).toBe(true);
    expect(sameInstantText("2026-01-05T09:00:00.000Z", undefined)).toBe(false);
  });

  it("a deadline is due at its own instant, not a millisecond before; none is never due", () => {
    const deadline = "2026-01-05T09:00:00.000Z";
    const at = instantOf(deadline).getTime();
    expect(isDueAt(deadline, new Date(at - 1))).toBe(false);
    expect(isDueAt(deadline, new Date(at))).toBe(true);
    expect(isDueAt(deadline, new Date(at + 1))).toBe(true);
    expect(isDueAt(undefined, new Date(at))).toBe(false);
  });
});
