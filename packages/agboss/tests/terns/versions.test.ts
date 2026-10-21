import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { executionVersions } from "../../src/index.js";
import { NonJsonValueError, shortVersion, stableJson, versionOf } from "../../src/terns/index.js";
import { fakeDeps } from "../helpers.js";

/** An IEEE 754 double from its 16 hex digits (RFC 8785 Appendix B notation). */
const double = (hex: string): number => Buffer.from(hex, "hex").readDoubleBE(0);

/** A data property named `__proto__` (an object literal would set the prototype instead). */
const withProtoKey = (): object => JSON.parse('{"__proto__":{"x":1},"a":2}') as object;

describe("canonical JSON (RFC 8785)", () => {
  it("AC1: the RFC 8785 §3.2.2 example serialises to the expected text", () => {
    const input = {
      numbers: [Number("333333333.33333329"), 1e30, 4.5, 2e-3, 0.000000000000000000000000001],
      string: '\u20ac$\u000f\nA\'B"\\\\"/',
      literals: [null, true, false],
    };

    expect(stableJson(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
        '"string":"\u20ac$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });

  it("AC1: keys sort by UTF-16 code units (RFC 8785 §3.2.3)", () => {
    const input = {
      "\u20ac": "Euro Sign",
      "\r": "Carriage Return",
      "\ufb33": "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      "\ud83d\ude00": "Emoji: Grinning Face",
      "\u0080": "Control",
      "\u00f6": "Latin Small Letter O With Diaeresis",
    };

    const keys = [...stableJson(input).matchAll(/"([^"]*)":/g)].map((match) => match[1]);
    expect(keys).toEqual(["\\r", "1", "\u0080", "\u00f6", "\u20ac", "\ud83d\ude00", "\ufb33"]);
  });

  it.each([
    ["0000000000000000", "0"],
    ["8000000000000000", "0"],
    ["0000000000000001", "5e-324"],
    ["8000000000000001", "-5e-324"],
    ["7fefffffffffffff", "1.7976931348623157e+308"],
    ["4340000000000000", "9007199254740992"],
    ["4430000000000000", "295147905179352830000"],
    ["44b52d02c7e14af5", "9.999999999999997e+22"],
    ["44b52d02c7e14af6", "1e+23"],
    ["3eb0c6f7a0b5ed8d", "0.000001"],
    ["3eb0c6f7a0b5ed8c", "9.999999999999997e-7"],
    ["41b3de4355555553", "333333333.3333332"],
    ["444b1ae4d6e2ef50", "1e+21"],
    ["444b1ae4d6e2ef4f", "999999999999999900000"],
  ])("AC1: number %s → %s (RFC 8785 Appendix B)", (hex, expected) => {
    expect(stableJson(double(hex))).toBe(expected);
  });

  it("AC1: nested objects and arrays, non-ASCII keys, empty containers, shortest numbers", () => {
    expect(stableJson({ z: 1, ä: 2, t: { b: [], a: {} }, n: [-0, 1e21, 1e-7] })).toBe(
      '{"n":[0,1e+21,1e-7],"t":{"a":{},"b":[]},"z":1,"ä":2}',
    );
    expect(stableJson({ b: 1, a: [2, { d: null, c: undefined }] })).toBe(
      '{"a":[2,{"d":null}],"b":1}',
    );
    expect(stableJson(withProtoKey())).toBe('{"__proto__":{"x":1},"a":2}');
    expect(stableJson(Object.assign(Object.create(null) as object, { b: 1, a: 2 }))).toBe(
      '{"a":2,"b":1}',
    );
  });

  it('AC5: integer-like keys are ordered as text ("10" before "9")', () => {
    expect(stableJson({ 9: "nine", 10: "ten", 1: "one" })).toBe(
      '{"1":"one","10":"ten","9":"nine"}',
    );
  });

  it("AC2: the same object gives byte-identical output under different locales", () => {
    const module = new URL("../../src/terns/versions.ts", import.meta.url).href;
    const script = `import { stableJson } from ${JSON.stringify(module)};
      process.stdout.write(stableJson({ t: 1, z: 2, ä: 3, a: { "10": 1, "9": 2 } }));`;
    const outputs = ["en_US.UTF-8", "et_EE.UTF-8", "sv_SE.UTF-8"].map((locale) =>
      execFileSync(process.execPath, ["--input-type=module", "-e", script], {
        env: { ...process.env, LANG: locale, LC_ALL: locale },
        encoding: "utf8",
      }),
    );

    expect(outputs).toEqual(Array<string>(3).fill('{"a":{"10":1,"9":2},"t":1,"z":2,"ä":3}'));
  });

  it.each([
    ["NaN", { a: NaN }, "$.a"],
    ["Infinity", { a: [1, 2, Infinity] }, "$.a[2]"],
    ["-Infinity", [-Infinity], "$[0]"],
    ["undefined in an array", { a: [1, 2, undefined] }, "$.a[2]"],
    ["undefined at the top", undefined, "$"],
    ["a lone surrogate", { s: "\ud800" }, "$.s"],
    ["a lone surrogate in a key", { "\udc00x": 1 }, '$["\\udc00x"]'],
    ["a Map", { m: new Map() }, "$.m"],
    ["a Set", { "my set": new Set() }, '$["my set"]'],
    ["a Date", { when: new Date(0) }, "$.when"],
    ["a class instance", { e: new Error("x") }, "$.e"],
    ["a bigint", { n: 1n }, "$.n"],
    ["a function", { f: () => 1 }, "$.f"],
    ["a symbol", [Symbol("s")], "$[0]"],
  ])("AC3: %s throws, naming its path", (_name, value, path) => {
    expect(() => stableJson(value)).toThrow(NonJsonValueError);
    expect(() => stableJson(value)).toThrow(`not JSON at ${path}:`);
  });

  it("AC3: a circular reference throws instead of overflowing; a shared value does not", () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    const shared = { x: 1 };

    expect(() => stableJson(loop)).toThrow("not JSON at $.self: circular reference");
    expect(stableJson({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
  });
});

describe("versions", () => {
  it("AC4: versionOf is 64 hex, shortVersion is its first 8; equal in → equal out", () => {
    const version = versionOf({ a: 1, b: [1, 2] });

    expect(version).toMatch(/^[0-9a-f]{64}$/);
    expect(shortVersion(version)).toBe(version.slice(0, 8));
    expect(shortVersion(version)).toHaveLength(8);
    expect(versionOf({ b: [1, 2], a: 1 })).toBe(version);
    expect(versionOf({ a: 1, b: [1, 3] })).not.toBe(version);
  });

  it("AC4: same config → same versions; a prompt change → a new prompt version only", async () => {
    const deps = await fakeDeps({});
    const changed = {
      ...deps,
      prompts: { ...deps.prompts, "alpha-agent": "You are alpha, now terse." },
    };

    expect(executionVersions(deps)).toEqual(executionVersions(await fakeDeps({})));
    expect(executionVersions(changed).promptVersion).not.toBe(
      executionVersions(deps).promptVersion,
    );
    expect(executionVersions(changed).modelVersion).toBe(executionVersions(deps).modelVersion);
    expect(executionVersions(deps).configHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
