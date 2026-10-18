import { describe, expect, it } from "vitest";
import { canonicalJson, CanonicalJsonError } from "./canonical-json.js";

describe("spike #115 — RFC 8785 canonical JSON", () => {
  it("sorts keys by UTF-16 code units, as in RFC 8785 §3.2.3", () => {
    const value = {
      "€": "Euro Sign",
      "\r": "Carriage Return",
      דּ: "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      "😀": "Emoji: Grinning Face",
      "\u0080": "Control",
      ö: "Latin Small Letter O With Diaeresis",
    };
    const inOrder = ["Carriage", "One", "Control", "Latin", "Euro", "Emoji", "Hebrew"];

    const text = canonicalJson(value);

    // read the text itself: JSON.parse would move the integer-like key "1" first again
    const positions = inOrder.map((word) => text.indexOf(word));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("serialises numbers in the ECMAScript shortest form (RFC 8785 §3.2.2.3)", () => {
    const numbers = [333333333.3333333, 1e30, 4.5, 0.002, 1e-27, -0, 1, 1.0, 0.1 + 0.2];

    expect(canonicalJson(numbers)).toBe(
      "[333333333.3333333,1e+30,4.5,0.002,1e-27,0,1,1,0.30000000000000004]",
    );
  });

  it("escapes strings like RFC 8785 §3.2.2.2: short escapes, lowercase \\u00xx, no escaping of U+2028", () => {
    expect(canonicalJson('\u0008\t\n\f\r\u001f"\\/\u2028\u00e9')).toBe(
      '"\\b\\t\\n\\f\\r\\u001f\\"\\\\/ é"',
    );
  });

  it("gives the same text for objects that differ only in key insertion order", () => {
    const a = { model: "m", temperature: 0.1, requestFields: { top_p: 1, seed: 7 } };
    const b = { requestFields: { seed: 7, top_p: 1 }, temperature: 0.1, model: "m" };

    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it("drops undefined properties: a field not sent is not a field sent as null", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalJson({ a: 1, b: null })).toBe('{"a":1,"b":null}');
  });

  it.each([
    ["NaN", { temperature: Number.NaN }],
    ["Infinity", { maxTokens: Number.POSITIVE_INFINITY }],
    ["a lone surrogate", { prompt: "broken \ud800 text" }],
    ["undefined in an array", [1, undefined]],
    ["a Map", { fields: new Map([["a", 1]]) }],
    ["a class instance", { at: new Date(0) }],
    ["a bigint", { n: 1n }],
    ["a function", { f: () => 1 }],
  ])("rejects %s instead of hashing it as null or {}", (_name, value) => {
    expect(() => canonicalJson(value)).toThrow(CanonicalJsonError);
  });
});
