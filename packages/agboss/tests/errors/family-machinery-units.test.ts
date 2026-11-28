/**
 * #1356 (WP6, takeover shard): the family machinery on its own, with families made here — what a
 * variant keeps as facts and as the record's details, its sentence and its cause, the reserved fact
 * names, how a family is declared (and refused) and how its spend is read. Exact values, no store.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGBossError, type ErrorDetails } from "../../src/core/errors.js";
import { argsOf } from "../../src/core/error-families/family-args.js";
import {
  defineFamily,
  isErrorFamily,
  plainly,
  type VariantSpec,
} from "../../src/core/error-families/family.js";
import { instantText, timeText } from "../../src/core/error-families/time-text.js";

type Facts = Readonly<Record<string, unknown>>;
type Variant = AGBossError & { readonly kind: string; readonly usage?: unknown } & Facts;
type VariantClass = (new (options?: Facts) => Variant) & { readonly code: string };
type TestFamily = (abstract new (...args: never[]) => AGBossError) & {
  readonly code: string;
  readonly Plain: VariantClass;
  readonly Coded: VariantClass;
  readonly Made: VariantClass;
};

const familyOf = (variants: Facts, paid?: true): TestFamily =>
  defineFamily<TestFamily>({
    name: "TestError",
    code: "test",
    kinds: { Plain: "plain", Coded: "coded", Made: "made" },
    variants: variants as never,
    ...(paid === undefined ? {} : { paid }),
  });

const argsFor = (spec: VariantSpec, options: Facts = {}): ReturnType<typeof argsOf> =>
  argsOf(spec, options);

describe("what a variant keeps as the record's details", () => {
  it("keeps the plain facts: texts, numbers, booleans, null and lists of them, and drops the rest", () => {
    const { base } = argsFor(["sentence"], {
      text: "t",
      count: 3,
      flag: false,
      nothing: null,
      list: ["a", "b"],
      numbers: [1, 2],
      empty: [],
      object: { a: 1 },
      mixed: ["a", { b: 1 }],
      mixedFirst: [{ b: 1 }, "a"],
      big: 10n,
      fn: () => 1,
      sym: Symbol("s"),
      missing: undefined,
    });

    expect(base.details).toStrictEqual({
      text: "t",
      count: 3,
      flag: false,
      nothing: null,
      list: ["a", "b"],
      numbers: [1, 2],
      empty: [],
    });
  });

  it("says a Date fact as ISO 8601 text, and a Date of no instant as such", () => {
    const { base } = argsFor(["sentence"], {
      at: new Date("2026-11-27T10:00:00.000Z"),
      never: new Date(Number.NaN),
    });

    expect(base.details).toStrictEqual({
      at: "2026-11-27T10:00:00.000Z",
      never: "an invalid time",
    });
  });

  it("leaves out the usage, and a fact the variant hides", () => {
    const { base, facts } = argsFor(["sentence", undefined, { hidden: ["secret"] }], {
      usage: [1, 2],
      secret: "s3",
      shown: "yes",
    });

    expect(base.details).toStrictEqual({ shown: "yes" });
    expect(facts).toStrictEqual({ usage: [1, 2], secret: "s3", shown: "yes" });
  });

  it("shows every fact when the variant hides none", () => {
    expect(argsFor(["sentence"], { a: "a", b: "b" }).base.details).toStrictEqual({
      a: "a",
      b: "b",
    });
  });

  it("adds what the variant's extra says, and the caller's own details win over both", () => {
    const spec: VariantSpec = [
      "sentence",
      undefined,
      { extra: (facts: never) => ({ fromExtra: `x-${String((facts as Facts).n)}`, n: 99 }) },
    ];

    expect(argsFor(spec, { n: 7 }).base.details).toStrictEqual({ n: 99, fromExtra: "x-7" });
    expect(
      argsFor(spec, { n: 7, details: { fromExtra: "mine", more: 1 } }).base.details,
    ).toStrictEqual({ n: 99, fromExtra: "mine", more: 1 });
  });

  it("takes only an object as the caller's details", () => {
    expect(argsFor(["s"], { a: 1, details: "ab" }).base.details).toStrictEqual({ a: 1 });
    expect(argsFor(["s"], { a: 1, details: null as never }).base.details).toStrictEqual({ a: 1 });
    expect(argsFor(["s"], { a: 1, details: 5 }).base.details).toStrictEqual({ a: 1 });
    expect(argsFor(["s"], { a: 1, details: { b: 2 } }).base.details).toStrictEqual({
      a: 1,
      b: 2,
    });
  });
});

describe("the base's own options pass through", () => {
  it("hands the location, spans, notes, help and patch to the base, and takes them out of the facts", () => {
    const location = { file: "f.ts", line: 1, column: 2 } as never;
    const result = argsFor(["sentence"], {
      location,
      secondarySpans: [],
      notes: ["n"],
      help: "h",
      suggestionPatch: "p",
      kept: 1,
    });

    expect(result.base).toStrictEqual({
      cause: undefined,
      location,
      secondarySpans: [],
      notes: ["n"],
      help: "h",
      suggestionPatch: "p",
      details: { kept: 1 },
    });
    expect(result.facts).toStrictEqual({ kept: 1 });
  });
});

describe("a variant's sentence", () => {
  it("is the caller's own message when it is a text, whatever the facts say", () => {
    expect(argsFor(["default"], { message: "mine" }).message).toBe("mine");
    expect(argsFor(["default"], { message: "" }).message).toBe("");
    expect(argsFor(["default"], { message: 5 }).message).toBe("default");
  });

  it("is a fixed text, or made of the facts and the cause", () => {
    const made: VariantSpec = [
      (facts: { readonly n: number; readonly cause: unknown }) =>
        `n is ${String(facts.n)}, cause ${String(facts.cause)}`,
    ] as never;

    expect(argsFor(made, { n: 4 }).message).toBe("n is 4, cause undefined");
    expect(argsFor(made, { n: 4, cause: "boom" }).message).toBe("n is 4, cause boom");
  });

  it("is `plain` when a fact it needs is absent, undefined or empty, else made of the facts", () => {
    const spec: VariantSpec = plainly(
      [(facts: { readonly a: string; readonly b: string }) => `${facts.a}/${facts.b}`] as never,
      ["a", "b"],
      "no a or b",
    );

    expect(argsFor(spec, { a: "x", b: "y" }).message).toBe("x/y");
    expect(argsFor(spec, { b: "y" }).message).toBe("no a or b");
    expect(argsFor(spec, { a: "x" }).message).toBe("no a or b");
    expect(argsFor(spec, { a: "x", b: undefined }).message).toBe("no a or b");
    expect(argsFor(spec, { a: "x", b: "" }).message).toBe("no a or b");
    expect(argsFor(spec, { a: "", b: "y" }).message).toBe("no a or b");
    expect(argsFor(spec, { a: "x", b: "0" }).message).toBe("x/0");
  });

  it("is the default when the facts it needs are absent but the variant has no plain sentence", () => {
    const spec: VariantSpec = ["the default", undefined, { needs: ["a"] }];

    expect(argsFor(spec, {}).message).toBe("the default");
  });

  it("is the default when the variant has a plain sentence but needs no fact", () => {
    expect(argsFor(["the default", undefined, { plain: "plain" }], {}).message).toBe("the default");
  });
});

describe("a variant's cause", () => {
  const spec: VariantSpec = [
    "s",
    undefined,
    { cause: (facts: never) => new Error(`failed at ${(facts as Facts).where as string}`) },
  ];

  it("is the one it was given", () => {
    const given = new Error("given");

    expect(argsFor(spec, { where: "w", cause: given }).base.cause).toBe(given);
  });

  it("is made of the facts when none was given and the variant says how", () => {
    const cause = argsFor(spec, { where: "w" }).base.cause;

    expect(cause).toBeInstanceOf(Error);
    expect((cause as Error).message).toBe("failed at w");
  });

  it("is none when none was given and the variant says nothing", () => {
    expect(argsFor(["s"], { where: "w" }).base.cause).toBeUndefined();
  });

  it("is a falsy cause as given", () => {
    expect(argsFor(spec, { where: "w", cause: null }).base.cause).toBeNull();
  });
});

describe("the facts a variant keeps", () => {
  it("are what it was given, none of the base's options", () => {
    expect(argsFor(["s"], { a: 1, message: "m", cause: "c", help: "h" }).facts).toStrictEqual({
      a: 1,
    });
  });

  it.each(["kind", "code", "name", "spend"])("refuses %s: the instance owns it", (name) => {
    expect(() => argsFor(["s"], { [name]: "x" })).toThrow(
      new TypeError(`"${name}" is not a fact of an error: the instance owns it`),
    );
  });

  it("refuses a reserved fact even when it is undefined, and says the first one it finds", () => {
    expect(() => argsFor(["s"], { name: undefined })).toThrow(/"name" is not a fact/);
    expect(() => argsFor(["s"], { spend: 1, code: 2 })).toThrow(/"code" is not a fact/);
  });

  it("keep fills in what was not given", () => {
    const spec: VariantSpec = ["s", undefined, { keep: () => ({ filled: "k", own: "from keep" }) }];

    expect(argsFor(spec, { own: "given" }).facts).toStrictEqual({ filled: "k", own: "given" });
  });

  it("keep fills in what was given as undefined, while a fact undefined and not derived stays a key", () => {
    const spec: VariantSpec = ["s", undefined, { keep: () => ({ derived: 5 }) }];
    const { facts } = argsFor(spec, { derived: undefined, plain: undefined });

    expect(facts).toStrictEqual({ derived: 5, plain: undefined });
    expect(Object.keys(facts).sort()).toStrictEqual(["derived", "plain"]);
  });

  it("without keep, a fact given as undefined stays a key", () => {
    const { facts } = argsFor(["s"], { gone: undefined });

    expect(Object.keys(facts)).toStrictEqual(["gone"]);
  });

  it("force: keep replaces what was given, and the rest of what was given stays", () => {
    const spec: VariantSpec = ["s", undefined, { keep: () => ({ text: "clean" }), force: true }];

    expect(argsFor(spec, { text: "dirty", other: 1 }).facts).toStrictEqual({
      text: "clean",
      other: 1,
    });
    expect(
      argsFor(["s", undefined, { keep: () => ({ text: "clean" }), force: false }], {
        text: "dirty",
      }).facts,
    ).toStrictEqual({ text: "dirty" });
  });
});

describe("a time text", () => {
  it("is the fallback for none, ISO 8601 for a time and a word for a Date of no instant", () => {
    expect(timeText(undefined, "none")).toBe("none");
    expect(timeText(new Date("2026-11-27T10:00:00.000Z"), "none")).toBe("2026-11-27T10:00:00.000Z");
    expect(timeText(new Date(Number.NaN), "none")).toBe("an invalid time");
    expect(instantText(new Date(0))).toBe("1970-01-01T00:00:00.000Z");
    expect(instantText(new Date(Number.NaN))).toBe("an invalid time");
  });
});

describe("a declared family", () => {
  const family = familyOf({
    Plain: ["a plain sentence"],
    Coded: ["a coded sentence", "test.special"],
    Made: [(facts: { readonly n: number }) => `made of ${String(facts.n)}`],
  });

  it("is an error family, and no other function, class or value is", () => {
    expect(isErrorFamily(family)).toBe(true);
    expect(isErrorFamily(family.Plain)).toBe(false);
    expect(isErrorFamily(AGBossError)).toBe(false);
    expect(isErrorFamily(() => 1)).toBe(false);
    expect(
      isErrorFamily(
        class Empty {
          readonly x = 1;
        },
      ),
    ).toBe(false);
    expect(isErrorFamily({})).toBe(false);
    expect(isErrorFamily(new family.Plain())).toBe(false);
    expect(isErrorFamily(5)).toBe(false);
    expect(isErrorFamily("TestError")).toBe(false);
    expect(isErrorFamily(null)).toBe(false);
    expect(isErrorFamily(undefined)).toBe(false);
  });

  it("names its base and each variant `Family.Variant`, and each error by its class", () => {
    expect(family.name).toBe("TestError");
    expect(family.Plain.name).toBe("TestError.Plain");
    expect(family.Made.name).toBe("TestError.Made");
    expect(new family.Plain().name).toBe("TestError.Plain");
  });

  it("codes the variants `<family code>.<kind>` unless the variant says its own", () => {
    expect(family.code).toBe("test");
    expect(family.Plain.code).toBe("test.plain");
    expect(family.Made.code).toBe("test.made");
    expect(family.Coded.code).toBe("test.special");
    expect(new family.Plain().code).toBe("test.plain");
    expect(new family.Coded().code).toBe("test.special");
  });

  it("makes errors that are the family's, of their kind, with their sentence, facts and details", () => {
    const plain = new family.Plain({ extra: "e" });
    const made = new family.Made({ n: 3 });

    expect(plain).toBeInstanceOf(family);
    expect(plain).toBeInstanceOf(family.Plain);
    expect(plain).not.toBeInstanceOf(family.Made);
    expect(plain).toBeInstanceOf(AGBossError);
    expect(plain.kind).toBe("plain");
    expect(plain.message).toBe("a plain sentence");
    expect(plain.extra).toBe("e");
    expect(plain.details).toStrictEqual({ extra: "e" });
    expect(made.kind).toBe("made");
    expect(made.message).toBe("made of 3");
    expect(made.n).toBe(3);
    expect(new family.Plain({ message: "mine" }).message).toBe("mine");
  });

  it("makes an error with no argument at all", () => {
    const error = new family.Plain();

    expect(error.message).toBe("a plain sentence");
    expect(error.details).toStrictEqual({});
  });

  it("refuses a fact the instance owns", () => {
    expect(() => new family.Plain({ kind: "other" })).toThrow(
      new TypeError('"kind" is not a fact of an error: the instance owns it'),
    );
  });

  it("an error of a family that is not paid has no usage and no spend", () => {
    const error = new family.Plain();

    expect(error.usage).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(family.prototype), "spend")).toBe(
      undefined,
    );
    expect("spend" in error).toBe(false);
  });
});

describe("a family that is refused", () => {
  const refused = (variants: Facts, kinds?: Facts): (() => TestFamily) => {
    return () =>
      defineFamily<TestFamily>({
        name: "TestError",
        code: "test",
        kinds: (kinds ?? { Plain: "plain" }) as never,
        variants: variants as never,
      });
  };

  it.each([
    ["no spec at all", { Plain: undefined }],
    ["a text for a spec", { Plain: "a sentence" }],
    ["an object that looks like a list", { Plain: { 0: "a sentence" } }],
    ["a list that starts with a number", { Plain: [5] }],
    ["an empty list", { Plain: [] }],
    ["a list that starts with null", { Plain: [null, "x"] }],
  ])("by its spec: %s", (_label, variants) => {
    expect(refused(variants)).toThrow(new TypeError("TestError.Plain is not declared"));
  });

  it("by its kind: a variant with no kind is not declared, whatever its spec", () => {
    expect(refused({ Plain: ["a sentence"] }, {})).toThrow(
      new TypeError("TestError.Plain is not declared"),
    );
    expect(refused({ Plain: ["a sentence"] }, { Plain: 5 })).toThrow(
      new TypeError("TestError.Plain is not declared"),
    );
  });

  it("takes a spec that starts with a text or with a function", () => {
    expect(refused({ Plain: ["a sentence"] })).not.toThrow();
    expect(refused({ Plain: [() => "a sentence"] })).not.toThrow();
  });
});

describe("the spend of a paid family", () => {
  afterEach(() => {
    vi.resetModules();
  });

  const paidFamily = async (): Promise<{
    readonly Paid: TestFamily;
    readonly setSpendReport: (report: (usage: readonly never[]) => unknown) => void;
  }> => {
    vi.resetModules();
    const { defineFamily: define } = await import("../../src/core/error-families/family.js");
    const { setSpendReport } = await import("../../src/core/error-families/spend-report.js");
    const Paid = define<TestFamily>({
      name: "PaidError",
      code: "paid",
      kinds: { Plain: "plain", Coded: "coded", Made: "made" },
      variants: { Plain: ["paid"], Coded: ["coded"], Made: ["made"] } as never,
      paid: true,
    });
    return { Paid, setSpendReport: setSpendReport as never };
  };

  it("an error carries its usage, and `spend` is the report of that usage, made when read", async () => {
    const { Paid, setSpendReport } = await paidFamily();
    const report = vi.fn((usage: readonly never[]) => ({ made: "report", of: usage }));
    setSpendReport(report);
    const usage = [{ costUsd: 1 }] as never;
    const error = new Paid.Plain({ usage });

    expect(report).not.toHaveBeenCalled();
    expect(error.usage).toBe(usage);
    expect(error.spend).toStrictEqual({ made: "report", of: usage });
    expect(report).toHaveBeenCalledExactlyOnceWith(usage);
  });

  it("an error made with no usage carries none, and its spend is the report of none", async () => {
    const { Paid, setSpendReport } = await paidFamily();
    setSpendReport((usage) => ({ of: usage }));
    const error = new Paid.Plain();

    expect(error.usage).toStrictEqual([]);
    expect(error.spend).toStrictEqual({ of: [] });
    expect(error.details).toBeDefined();
    expect(Object.keys(error.details ?? {})).not.toContain("usage");
  });

  it("reads of a report that is not set yet throw, saying so", async () => {
    vi.resetModules();
    const { spendReportOf } = await import("../../src/core/error-families/spend-report.js");

    expect(() => spendReportOf([])).toThrow(
      new TypeError("the spend of a paid error was read before finops/cost-report was loaded"),
    );
  });
});
