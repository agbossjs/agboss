/**
 * #1307 (G3, Q-A): a pause's times are `Date`s, and `===` on two `Date`s compares references. The
 * helpers every compare-and-set, ceiling and due check goes through compare instants; these properties
 * hold over any millisecond, and the table pins what the naive operators get wrong.
 */
import fc from "fast-check";
import { StoreError } from "../../src/core/error-families/store-errors.js";
import { describe, expect, it } from "vitest";
import {
  compareInstants,
  copyOf,
  copyOfOptional,
  earliestOf,
  instantOfText,
  isAtOrBefore,
  isBefore,
  isCanonicalInstantText,
  isDeadlineDue,
  sameInstant,
} from "../../src/infrastructure/instants.js";

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

describe("isAtOrBefore, compareInstants, earliestOf, isDeadlineDue (#1307)", () => {
  it("a deadline at the moment is over: at-or-before is inclusive, before is strict, by milliseconds", () => {
    fc.assert(
      fc.property(near, near, (x, y) => {
        const a = new Date(x);
        const b = new Date(y);
        expect(isAtOrBefore(a, b)).toBe(x <= y);
        expect(isAtOrBefore(a, new Date(x))).toBe(true);
        expect(Math.sign(compareInstants(a, b))).toBe(Math.sign(x - y));
      }),
      SEED,
    );
  });

  it("a deadline is due at its own instant, not a millisecond before; none is never due", () => {
    const at = new Date("2026-01-05T09:00:00.000Z").getTime();
    const deadline = new Date(at);

    expect(isDeadlineDue(deadline, new Date(at - 1))).toBe(false);
    expect(isDeadlineDue(deadline, new Date(at))).toBe(true);
    expect(isDeadlineDue(deadline, new Date(at + 1))).toBe(true);
    expect(isDeadlineDue(undefined, new Date(at))).toBe(false);
  });

  it("the earliest of the instants given is the earliest by milliseconds, whatever the order and the absent ones", () => {
    fc.assert(
      fc.property(fc.array(near, { minLength: 1, maxLength: 6 }), (millis) => {
        const dates = millis.map((ms) => new Date(ms));
        const found = earliestOf(undefined, ...dates, undefined);

        expect(found?.getTime()).toBe(Math.min(...millis));
        expect(earliestOf(...[...dates].reverse())?.getTime()).toBe(Math.min(...millis));
      }),
      SEED,
    );
    expect(earliestOf()).toBeUndefined();
    expect(earliestOf(undefined, undefined)).toBeUndefined();
  });

  it("a tie keeps the first given", () => {
    const first = new Date(5);
    const second = new Date(5);

    expect(earliestOf(first, second)).toBe(first);
  });
});

describe("copyOf (#1307, L2)", () => {
  it("is another Date of the same instant: moving the copy never moves the original", () => {
    fc.assert(
      fc.property(millis, (ms) => {
        const original = new Date(ms);
        const copy = copyOf(original);

        expect(copy).not.toBe(original);
        expect(copy.getTime()).toBe(ms);
        copy.setTime(0);
        expect(original.getTime()).toBe(ms);
      }),
      SEED,
    );
    expect(copyOfOptional(undefined)).toBeUndefined();
    expect(copyOfOptional(new Date(7))?.getTime()).toBe(7);
  });
});

describe("the text a store keeps of a time (#1307, Q-A)", () => {
  /** The canonical texts: what `toISOString()` writes, years 0000-9999. */
  const canonical = near.map((ms) => new Date(ms).toISOString());
  const anyYear = fc.integer({ min: -62_167_219_200_000, max: 253_402_300_799_999 });

  it("what toISOString() writes is read back as the very instant, to the millisecond", () => {
    fc.assert(
      fc.property(anyYear, (ms) => {
        const text = new Date(ms).toISOString();

        expect(isCanonicalInstantText(text)).toBe(true);
        expect(instantOfText(text, "expiresAt").getTime()).toBe(ms);
      }),
      SEED,
    );
  });

  it("for every text that is read, the order of the instants is the order of the texts a column indexes", () => {
    fc.assert(
      fc.property(canonical, canonical, (a, b) => {
        expect(isBefore(instantOfText(a, "a"), instantOfText(b, "b"))).toBe(a < b);
        expect(sameInstant(instantOfText(a, "a"), instantOfText(b, "b"))).toBe(a === b);
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
      "2026-01-05T09:00:00.0000Z",
      "2026-01-05t09:00:00.000z",
      " 2026-01-05T09:00:00.000Z",
      "2026-01-05T09:00:00.000Z ",
      "nonsense",
      "",
    ]) {
      expect(isCanonicalInstantText(text)).toBe(false);
      expect(() => instantOfText(text, "expiresAt")).toThrow(StoreError.UnreadableRecord);
    }
  });

  it("the error names the field and the record, and never the value", () => {
    const secret = "not-a-time-4711";

    const thrown = (() => {
      try {
        return instantOfText(secret, "expiresAt", "pause notice mailbox");
      } catch (error) {
        return error;
      }
    })();

    expect(thrown).toBeInstanceOf(StoreError.UnreadableRecord);
    expect((thrown as Error).message).toContain("expiresAt");
    expect((thrown as Error).message).toContain("pause notice mailbox");
    expect(JSON.stringify(thrown)).not.toContain(secret);
  });
});
