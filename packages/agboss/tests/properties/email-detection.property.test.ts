/**
 * #729 — fail-closed: no text holding a valid address leaves a character of it outside an e-mail
 * match, whatever comes before or after it (letters, digits, dots, a file extension).
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { findFormatRanges } from "../../src/pii/detectors/find.js";
import { PiiKind } from "../../src/pii/kinds.js";

const EMAIL = new Set([PiiKind.Email]);
const word = (chars: string, min: number, max: number): fc.Arbitrary<string> =>
  fc.string({ unit: fc.constantFrom(...Array.from(chars)), minLength: min, maxLength: max });
const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

const address = fc
  .tuple(
    word(`${ALNUM}._+-`, 1, 8),
    fc.array(word(ALNUM, 1, 6), { minLength: 1, maxLength: 3 }),
    // real top-level domains, some of them also file extensions elsewhere (.md, .zip)
    fc.constantFrom("com", "org", "io", "co", "uk", "de", "dev", "info", "md", "zip", "mov"),
  )
  .map(([local, labels, tld]) => `${local}@${labels.join(".")}.${tld}`);
const around = word(`${ALNUM} .,;:()-_`, 0, 6);
const extension = fc.constantFrom("", ".pdf", ".csv", ".mp4", ".zip", ".md", "1", "X", ".");

describe("#729: the e-mail detector never under-detects", () => {
  it("every character of a valid address is inside a found e-mail range", () => {
    fc.assert(
      fc.property(around, address, extension, around, (before, email, tail, after) => {
        const text = `${before} ${email}${tail}${after}`;
        const at = before.length + 1;
        const ranges = findFormatRanges(text, EMAIL);
        const covered = (index: number): boolean =>
          ranges.some(({ start, end }) => start <= index && index < end);
        const missed = Array.from({ length: email.length }, (_, offset) => at + offset).filter(
          (index) => !covered(index),
        );
        expect(missed).toEqual([]);
      }),
      { numRuns: 2000 },
    );
  });
});
