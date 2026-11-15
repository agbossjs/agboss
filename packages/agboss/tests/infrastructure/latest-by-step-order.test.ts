/** #1115: the tie order of `latestByStep` is code point order, the one a SQL store's byte order gives. */
import { describe, expect, it } from "vitest";
import { compareCodePoints, newestFirstOrder } from "../../src/infrastructure/latest-by-step.js";

/** JavaScript's `<`: UTF-16 code unit order. */
const lessByUnit = (first: string, second: string): boolean => first < second;
const sign = (value: number): number => Math.sign(value);

describe("#1115 AC1: compareCodePoints", () => {
  it("AC1: a character above U+FFFF is greater than one in U+E000..U+FFFF (not as `<` says)", () => {
    expect(lessByUnit("\u{10000}", "\uFFFF")).toBe(true); // the code unit order, the one the contract left
    expect(sign(compareCodePoints("\u{10000}", "\uFFFF"))).toBe(1);
    expect(sign(compareCodePoints("\uFFFF", "\u{10000}"))).toBe(-1);
    expect(sign(compareCodePoints("\u{10000}", ""))).toBe(1);
    expect(sign(compareCodePoints("\u{1F600}", "\u{10000}"))).toBe(1);
  });

  it("AC1: it agrees with the UTF-8 byte order (SQLite BINARY, COLLATE C) on a spread of text", () => {
    const samples = [
      "",
      "a",
      "Z",
      "ab",
      "\u007F",
      "\u0080",
      "߿",
      "ࠀ",
      "퟿",
      "",
      "�",
      "\uFFFF",
      "\u{10000}",
      "\u{10FFFF}",
      "a\u{10000}",
      "a\uFFFF",
      "\u{1F600}x",
    ];
    for (const first of samples)
      for (const second of samples) {
        const bytes = Buffer.compare(Buffer.from(first), Buffer.from(second));
        expect(sign(compareCodePoints(first, second)), JSON.stringify([first, second])).toBe(bytes);
      }
  });

  it("AC1: newestFirstOrder ranks the greater step, then the greater id by code point", () => {
    expect(newestFirstOrder({ step: 2, id: "a" }, { step: 1, id: "z" })).toBeLessThan(0);
    expect(newestFirstOrder({ step: 1, id: "\u{10000}" }, { step: 1, id: "\uFFFF" })).toBeLessThan(
      0,
    );
    expect(newestFirstOrder({ step: 1, id: "b" }, { step: 1, id: "b" })).toBe(0);
  });
});
