/** #1007: the stream trims as the reply node does — the deltas joined are `text.trim()`. */
import { describe, expect, it } from "vitest";
import { Trimmer } from "../../src/run/stream/trim.js";

function shown(pieces: readonly string[]): string {
  const trim = new Trimmer();
  const text = pieces.map((piece) => trim.push(piece)).join("");
  trim.end();
  return text;
}

describe("#1007: the trim invariant", () => {
  for (const reply of [
    "  hello  world \n",
    "\n\n  \thello",
    "hello\n\n",
    "   ",
    "",
    "a b\n c ",
    "  nbsp  ",
    "inner   space\nkept",
  ]) {
    it(`${JSON.stringify(reply)}: joined deltas === trim(), at every split`, () => {
      expect(shown([reply])).toBe(reply.trim());
      expect(shown(Array.from(reply))).toBe(reply.trim());
      for (let cut = 0; cut <= reply.length; cut += 1) {
        expect(shown([reply.slice(0, cut), reply.slice(cut)])).toBe(reply.trim());
      }
    });
  }

  it("whitespace is held until text follows, and a delta is never empty", () => {
    const trim = new Trimmer();
    expect([
      trim.push("  hi"),
      trim.push(" "),
      trim.push(" "),
      trim.push("you"),
      trim.push(" "),
    ]).toEqual(["hi", "", "", "  you", ""]);
  });
});
