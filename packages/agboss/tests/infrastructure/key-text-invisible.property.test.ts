/**
 * #556 AC2 — the property tests of #538 / #547 extended: no accepted key differs from another only by
 * a character #556 refuses. Any such character put into an accepted key, anywhere, or swapped for one
 * of its characters, gives a refused text — so two accepted keys never differ by one; and a store
 * that drops them silently merges no two accepted keys.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { KeyTextRule, keyTextRuleOf } from "../../src/errors.js";
import { seededProperties } from "../helpers/property-seed.js";

seededProperties("key-text-invisible.property.test.ts");

/** Code points that render as nothing but are not Cf (Default_Ignorable_Code_Point). */
const IGNORABLE = [
  0x034f,
  0x115f,
  0x1160,
  0x17b4,
  0x17b5,
  0x180b,
  0x180c,
  0x180d,
  0x180f,
  0x3164,
  0xffa0,
  ...Array.from({ length: 16 }, (_, index) => 0xfe00 + index),
  ...Array.from({ length: 240 }, (_, index) => 0xe0100 + index),
];

/** Private use and noncharacters: the BMP area's edges, planes 15 and 16, every plane's last two. */
const PRIVATE_OR_NONCHARACTER = [
  0xe000,
  0xf8ff,
  0xf0000,
  0xffffd,
  0x100000,
  0x10fffd,
  ...Array.from({ length: 32 }, (_, index) => 0xfdd0 + index),
  ...Array.from({ length: 17 }, (_, plane) => [
    plane * 0x10000 + 0xfffe,
    plane * 0x10000 + 0xffff,
  ]).flat(),
];

/** Unassigned in every supported runtime, and the braille blank. */
const OTHERS = [0x0378, 0x0379, 0x0380, 0x0530, 0x50000, 0x2800];

const REFUSED = [...IGNORABLE, ...PRIVATE_OR_NONCHARACTER, ...OTHERS].map((code) =>
  String.fromCodePoint(code),
);

/** Accepted keys of many scripts: letters, digits, CJK, Cyrillic, Hebrew, emoji, astral ideographs. */
const acceptedKey = fc
  .string({
    unit: fc.constantFrom(
      "a",
      "Z",
      "7",
      ":",
      "-",
      "注",
      "文",
      "ж",
      "ש",
      "🧾",
      "❤",
      "\u{20000}",
      "가",
    ),
    minLength: 1,
    maxLength: 30,
  })
  .filter((text) => keyTextRuleOf(text) === undefined);

const refused = fc.constantFrom(...REFUSED);

describe("#556 AC2: no accepted key differs from another only by a character #556 refuses", () => {
  it("each such character put in anywhere: refused", () => {
    fc.assert(
      fc.property(acceptedKey, refused, fc.nat(), (key, char, at) => {
        const cut = Array.from(key);
        const index = at % (cut.length + 1);
        const variant = [...cut.slice(0, index), char, ...cut.slice(index)].join("");
        expect(keyTextRuleOf(variant)).not.toBeUndefined();
      }),
      { numRuns: 3000 },
    );
  });

  it("each such character in place of one of the key's: refused", () => {
    fc.assert(
      fc.property(acceptedKey, refused, fc.nat(), (key, char, at) => {
        const cut = Array.from(key);
        cut[at % cut.length] = char;
        expect(keyTextRuleOf(cut.join(""))).not.toBeUndefined();
      }),
      { numRuns: 3000 },
    );
  });

  it("a store dropping them silently merges no two accepted keys: every key is already without them", () => {
    const dropped = (text: string): string =>
      Array.from(text)
        .filter((char) => !REFUSED.includes(char))
        .join("");
    fc.assert(
      fc.property(fc.uniqueArray(acceptedKey, { minLength: 2, maxLength: 8 }), (keys) => {
        expect(new Set(keys.map(dropped)).size).toBe(keys.length);
      }),
      { numRuns: 1000 },
    );
  });

  it("each class is named by its own rule", () => {
    for (const code of IGNORABLE)
      expect(keyTextRuleOf(`a${String.fromCodePoint(code)}b`)).toBe(KeyTextRule.Ignorable);
    for (const code of PRIVATE_OR_NONCHARACTER)
      expect(keyTextRuleOf(`a${String.fromCodePoint(code)}b`)).toBe(
        KeyTextRule.PrivateOrNoncharacter,
      );
    expect(keyTextRuleOf("a\u0378b")).toBe(KeyTextRule.Unassigned);
    expect(keyTextRuleOf("a⠀b")).toBe(KeyTextRule.Blank);
  });
});
