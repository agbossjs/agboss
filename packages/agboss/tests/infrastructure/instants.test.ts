/**
 * #1307 (G3, Q-A): a pause's times are `Date`s, and `===` on two `Date`s compares references. The
 * helpers every compare-and-set, ceiling and due check goes through compare instants; these properties
 * hold over any millisecond, and the table pins what the naive operators get wrong.
 */
import fc from "fast-check";
import { StoreError } from "../../src/core/error-families/store-errors.js";
import { describe, expect, it } from "vitest";
import { isBefore, sameInstant } from "../../src/infrastructure/instants.js";
import {
  compareText,
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
        expect(Object.is(a, b)).toBe(false);
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

describe("isBefore (#1307)", () => {
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
});

describe("the texts a record keeps, compared by instant (#1307, until the record is typed)", () => {
  /** The canonical texts: what `toISOString()` writes, years 0000-9999. */
  const canonical = near.map((ms) => new Date(ms).toISOString());

  it("for every text that is read, the order and the sameness of the instants are those of the texts", () => {
    fc.assert(
      fc.property(canonical, canonical, (a, b) => {
        expect(isBeforeText(a, b)).toBe(a < b);
        expect(sameInstantText(a, b)).toBe(a === b);
        expect(Math.sign(compareText(a, b))).toBe(a < b ? -1 : a > b ? 1 : 0);
      }),
      SEED,
    );
  });

  it("a text that is no canonical toISOString() is refused loudly, whatever it would name", () => {
    for (const text of [
      "2026-01-05T09:00:00Z",
      "2026-01-05T11:00:00.000+02:00",
      "2026-01-05T09:00:00.000",
      "2026-01-05 09:00:00.000Z",
      "2026-01-05",
      "+010000-01-01T00:00:00.000Z",
      "2026-02-30T09:00:00.000Z",
      "nonsense",
      "",
    ]) {
      expect(() => instantOf(text)).toThrow(StoreError.UnreadableRecord);
      expect(() => isBeforeText(text, "2026-01-05T09:00:00.000Z")).toThrow(
        StoreError.UnreadableRecord,
      );
      expect(() => sameInstantText("2026-01-05T09:00:00.000Z", text)).toThrow(
        StoreError.UnreadableRecord,
      );
      expect(() => compareText(text, text)).toThrow(StoreError.UnreadableRecord);
      expect(() => isDueAt(text, new Date(0))).toThrow(StoreError.UnreadableRecord);
    }
  });

  it("the error names the field and never the value", () => {
    const secret = "not-a-time-4711";

    const thrown = (() => {
      try {
        return instantOf(secret, "expiresAt");
      } catch (error) {
        return error;
      }
    })();

    expect(thrown).toBeInstanceOf(StoreError.UnreadableRecord);
    expect((thrown as Error).message).toContain("expiresAt");
    expect(JSON.stringify(thrown)).not.toContain(secret);
  });

  it("a deadline is due at its own instant, not a millisecond before; none is never due", () => {
    const deadline = "2026-01-05T09:00:00.000Z";
    const at = instantOf(deadline).getTime();
    expect(isDueAt(deadline, new Date(at - 1))).toBe(false);
    expect(isDueAt(deadline, new Date(at))).toBe(true);
    expect(isDueAt(deadline, new Date(at + 1))).toBe(true);
    expect(isDueAt(undefined, new Date(at))).toBe(false);
  });

  it("absent times are the same only as each other", () => {
    expect(sameInstantText(undefined, undefined)).toBe(true);
    expect(sameInstantText("2026-01-05T09:00:00.000Z", undefined)).toBe(false);
  });
});
