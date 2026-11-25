/**
 * #1269 (files-pii mutation shard): the strict reading of a redaction model's answer — which shapes are
 * a regions list, which numbers are a fraction of the image, and the structural message of each refusal.
 */
import { describe, expect, it } from "vitest";
import {
  regionsOf,
  RegionsAnswerError,
  UNKNOWN_TARGET,
} from "../../src/files/redaction-regions.js";

const KNOWN = new Set(["card-number", "value"]);
const NBSP = String.fromCharCode(0xa0);
const BOX = { target: "card-number", x: 0.1, y: 0.1, w: 0.2, h: 0.2 };
const answerOf = (...regions: unknown[]): string => JSON.stringify({ regions });

/** The structural message a refused answer gives. */
function refusal(text: string): string {
  try {
    regionsOf(text, KNOWN);
  } catch (error) {
    expect(error).toBeInstanceOf(RegionsAnswerError);
    expect((error as RegionsAnswerError).name).toBe("RegionsAnswerError");
    return (error as RegionsAnswerError).message;
  }
  throw new Error("the answer was accepted");
}

describe("the answer's JSON: bare, or in a code fence", () => {
  it("an unlabeled fence, and a fence with no space before the JSON, are read", () => {
    expect(regionsOf(`\`\`\`\n${answerOf(BOX)}\n\`\`\``, KNOWN)).toEqual([BOX]);
    expect(regionsOf(`\`\`\`json${answerOf(BOX)}\`\`\``, KNOWN)).toEqual([BOX]);
    expect(regionsOf(`\`\`\`${answerOf(BOX)}\`\`\``, KNOWN)).toEqual([BOX]);
    expect(regionsOf(`text\n\`\`\`json\n${answerOf(BOX)}\n\`\`\`\nmore`, KNOWN)).toEqual([BOX]);
  });

  it("surrounding white space that JSON itself does not allow is trimmed", () => {
    expect(regionsOf(`${NBSP}${answerOf(BOX)}${NBSP}`, KNOWN)).toEqual([BOX]);
    expect(regionsOf(`\`\`\`json\n${answerOf(BOX)}${NBSP}\`\`\``, KNOWN)).toEqual([BOX]);
  });

  it("an answer that is no JSON is refused as having no regions list, never with the parser's words", () => {
    expect(refusal("card 4242 is here")).toBe("the answer has no regions list");
  });
});

describe("what is a regions list", () => {
  it("anything but an object with a list is refused", () => {
    expect(refusal('"regions"')).toBe("the answer has no regions list");
    expect(refusal("null")).toBe("the answer has no regions list");
    expect(refusal(JSON.stringify([BOX]))).toBe("the answer has no regions list");
    expect(refusal('{"regions":"all"}')).toBe("the answer has no regions list");
    expect(refusal("{}")).toBe("the answer has no regions list");
  });

  it("an empty list is no region", () => {
    expect(regionsOf('{"regions":[]}', KNOWN)).toEqual([]);
  });

  it("an entry that is no object is refused, by its place", () => {
    expect(refusal(answerOf(BOX, null))).toBe("region 2 of 2 is no object");
    expect(refusal(answerOf("text"))).toBe("region 1 of 1 is no object");
    expect(refusal(answerOf(7))).toBe("region 1 of 1 is no object");
    expect(refusal(answerOf([BOX]))).toBe("region 1 of 1 is no object");
    expect(refusal(answerOf(true))).toBe("region 1 of 1 is no object");
  });

  it("#1301: a target that is not known, or not a text, is kept as the unknown target (painted), and counted", () => {
    const counts: number[] = [];
    const unknown = { ...BOX, target: UNKNOWN_TARGET };

    expect(
      regionsOf(answerOf({ ...BOX, target: "email" }), KNOWN, undefined, (n) => counts.push(n)),
    ).toEqual([unknown]);
    expect(regionsOf(answerOf({ ...BOX, target: 5 }), KNOWN)).toEqual([unknown]);
    expect(regionsOf(answerOf({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }), KNOWN)).toEqual([
      { x: 0.1, y: 0.1, w: 0.2, h: 0.2, target: UNKNOWN_TARGET },
    ]);
    expect(
      regionsOf(
        answerOf(BOX, { ...BOX, target: "a" }, { ...BOX, target: "b" }),
        KNOWN,
        undefined,
        (n) => counts.push(n),
      ),
    ).toHaveLength(3);
    expect(counts).toEqual([1, 2]);
  });

  it("an unknown target with a region out of bounds is still refused: it cannot be painted", () => {
    expect(refusal(answerOf({ ...BOX, target: "email", w: 0 }))).toBe(
      "region 1 of 1 is out of bounds",
    );
  });
});

describe("a region is a fraction of the image", () => {
  const outOfBounds = (over: Record<string, unknown>) => refusal(answerOf({ ...BOX, ...over }));

  it("x and y may be 0 and up to 0.999999; w and h are above 0 and up to 1", () => {
    expect(regionsOf(answerOf({ ...BOX, x: 0, y: 0 }), KNOWN)).toEqual([{ ...BOX, x: 0, y: 0 }]);
    expect(regionsOf(answerOf({ ...BOX, x: 0.999999, y: 0.999999 }), KNOWN)).toHaveLength(1);
    expect(regionsOf(answerOf({ ...BOX, w: 1, h: 1 }), KNOWN)).toEqual([{ ...BOX, w: 1, h: 1 }]);
    expect(regionsOf(answerOf({ ...BOX, w: 0.000001, h: 0.000001 }), KNOWN)).toHaveLength(1);
  });

  it("outside those ranges the region is out of bounds, by its place", () => {
    expect(outOfBounds({ x: 1 })).toBe("region 1 of 1 is out of bounds");
    expect(outOfBounds({ y: 1 })).toBe("region 1 of 1 is out of bounds");
    expect(outOfBounds({ x: -0.0001 })).toBe("region 1 of 1 is out of bounds");
    expect(outOfBounds({ y: -0.0001 })).toBe("region 1 of 1 is out of bounds");
    expect(outOfBounds({ w: 0 })).toBe("region 1 of 1 is out of bounds");
    expect(outOfBounds({ h: 0 })).toBe("region 1 of 1 is out of bounds");
    expect(outOfBounds({ w: 1.0001 })).toBe("region 1 of 1 is out of bounds");
    expect(outOfBounds({ h: 1.0001 })).toBe("region 1 of 1 is out of bounds");
  });

  it("a number written as a text, a null or a missing number is out of bounds", () => {
    expect(outOfBounds({ x: "0.5" })).toBe("region 1 of 1 is out of bounds");
    expect(outOfBounds({ y: "0.5" })).toBe("region 1 of 1 is out of bounds");
    expect(outOfBounds({ w: "0.5" })).toBe("region 1 of 1 is out of bounds");
    expect(outOfBounds({ h: "0.5" })).toBe("region 1 of 1 is out of bounds");
    expect(outOfBounds({ h: null })).toBe("region 1 of 1 is out of bounds");
    expect(outOfBounds({ x: undefined })).toBe("region 1 of 1 is out of bounds");
  });

  it("a number too large for a double (read as infinity) is out of bounds", () => {
    const region = (x: string, w: string) =>
      `{"regions":[{"target":"card-number","x":${x},"y":0.1,"w":${w},"h":0.2}]}`;

    expect(refusal(region("1e999", "0.2"))).toBe("region 1 of 1 is out of bounds");
    expect(refusal(region("-1e999", "0.2"))).toBe("region 1 of 1 is out of bounds");
    expect(refusal(region("0.1", "1e999"))).toBe("region 1 of 1 is out of bounds");
  });

  it("the place counts the regions of the whole list", () => {
    expect(refusal(answerOf(BOX, BOX, { ...BOX, h: 2 }))).toBe("region 3 of 3 is out of bounds");
  });
});
