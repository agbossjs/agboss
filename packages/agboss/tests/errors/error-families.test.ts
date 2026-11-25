import { usd } from "../../src/units/index.js";
/**
 * #1325a: every error family is a base class with one class per variant — each an `AGBossError` of
 * its family, with its `kind`, a code of its family's line, a name qualified by the family's (so
 * `A2AError.Unavailable` and `McpError.Unavailable` never collide in a record or a hash), a default
 * sentence made of no fact, and its facts as own fields. The walk reads the families off the
 * entries, so a family without a case, a variant without a kind or a kind without a class fails it.
 */
import { describe, expect, it } from "vitest";
import * as a2a from "../../src/a2a/index.js";
import { errorRecordOf } from "../../src/core/error-record.js";
import { isErrorFamily } from "../../src/core/error-families/family.js";
import * as mcp from "../../src/mcp/index.js";
import { ComponentKind, bareRecordOf } from "../../src/flow/runtime/records.js";
import * as root from "../../src/index.js";
import * as stores from "../../src/stores/index.js";
import { AGBossError } from "../../src/index.js";

/** Every family constructor of every entry, by name, with its `kind` enum. */
const FAMILIES: ReadonlyMap<string, { readonly family: FamilyValue; readonly kinds: KindEnum }> =
  (() => {
    type Entry = Readonly<Record<string, unknown>>;
    const found = new Map<string, { family: FamilyValue; kinds: KindEnum }>();
    for (const entry of [root, a2a, mcp, stores] as readonly Entry[])
      for (const [name, value] of Object.entries(entry)) {
        const kinds = entry[`${name}Kind`];
        if (isErrorFamily(value) && typeof kinds === "object" && kinds !== null)
          found.set(name, { family: value as FamilyValue, kinds: kinds as KindEnum });
      }
    return found;
  })();

type KindEnum = Readonly<Record<string, string>>;
type FamilyValue = (abstract new (...args: never[]) => AGBossError) & {
  readonly code: string;
  readonly [variant: string]: unknown;
};
type VariantClass = (new (options?: object) => AGBossError & { readonly kind: string }) & {
  readonly code: string;
};

const variantOf = (family: FamilyValue, name: string): VariantClass => {
  const variant = family[name];
  if (typeof variant !== "function") throw new Error(`${name} is not a variant`);
  return variant as VariantClass;
};

/** The facts a variant takes that its constructor stores (a sample of each family's). */
const FACTS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  "LimitError.Items": { node: "fan-out", limit: 50, actual: 51, path: ["a"], spentUsd: usd(0.5) },
  "StepError.Agent": { agent: "buyer", nodeId: "buyer", visitNumber: 1 },
  "StepError.ToolTimeout": { tool: "pay", timeout: 30_000 },
  "GuardrailError.Blocked": { guardrail: "toxicity", refusal: "blocked", key: "k" },
  "PiiError.Refused": { piiKind: "email", refusal: "refused" },
  "ExecutionError.LeaseLost": { rootExecutionId: "run-1" },
  "ValidationError.TenantRequired": { operation: "execute" },
  "ValidationError.DtoInvalid": { dto: "Order", issues: [{ path: "id", reason: "missing" }] },
  "A2AError.Deadline": { deadlineAt: new Date(0) },
  "IdempotencyError.ResultTooLarge": { size: 20, maxResultSize: 10 },
  "OutboundCallError.PayloadTooLarge": { size: 20, maxPayloadSize: 10 },
};

const KEBAB = (name: string): string => name.replace(/(?<!^)(?=[A-Z])/g, "-").toLowerCase();

describe("#1325a: the error families", () => {
  it("the walk finds all sixteen families but ModelCallError (a single class)", () => {
    expect([...FAMILIES.keys()].sort()).toEqual(
      [
        "A2AError",
        "ConfigError",
        "DecisionError",
        "ExecutionError",
        "FileError",
        "GuardrailError",
        "IdempotencyError",
        "LimitError",
        "McpError",
        "OutboundCallError",
        "PauseError",
        "PiiError",
        "StepError",
        "StoreError",
        "ValidationError",
      ].sort(),
    );
  });

  it("every code and every qualified name of every variant is unique", () => {
    const codes = new Map<string, string>();
    const names = new Set<string>();
    for (const [family, { family: constructor, kinds }] of FAMILIES)
      for (const variant of Object.keys(kinds)) {
        const { code, name } = variantOf(constructor, variant);
        const holder = codes.get(code);
        expect(holder, `${code}: ${family}.${variant} and ${holder ?? ""}`).toBeUndefined();
        codes.set(code, `${family}.${variant}`);
        expect(names.has(name)).toBe(false);
        names.add(name);
      }
  });

  describe.each([...FAMILIES])("%s", (familyName, { family, kinds }) => {
    it("has one class per kind and one kind per class", () => {
      const variants = Object.keys(family).filter(
        (key) => typeof family[key] === "function" && key !== "of",
      );
      expect(variants.sort()).toEqual(Object.keys(kinds).sort());
      for (const [variant, kind] of Object.entries(kinds)) expect(kind).toBe(KEBAB(variant));
    });

    it("is a class: an ES6 constructor, with its own static code", () => {
      expect(family.toString().startsWith("class")).toBe(true);
      expect(Object.hasOwn(family, "code")).toBe(true);
      expect(Reflect.getPrototypeOf(family.prototype)).toBe(AGBossError.prototype);
    });

    describe.each(Object.entries(kinds))("%s", (variantName, kind) => {
      const Variant = variantOf(family, variantName);
      const facts = FACTS[`${familyName}.${variantName}`] ?? {};

      it("makes an AGBossError of the family, of its kind, named and coded", () => {
        const cause = new Error("the cause");
        const error = new Variant({ ...facts, cause });

        expect(error).toBeInstanceOf(Variant);
        expect(error).toBeInstanceOf(family);
        expect(error).toBeInstanceOf(AGBossError);
        expect(error).toBeInstanceOf(Error);
        expect(error.kind).toBe(kind);
        expect(error.name).toBe(`${familyName}.${variantName}`);
        expect(Variant.name).toBe(`${familyName}.${variantName}`);
        expect(error.code).toBe(Variant.code);
        expect(Variant.code.startsWith(`${family.code}.`)).toBe(true);
        expect(error.cause).toBe(cause);
      });

      it("says what happened without a fact: the same sentence whatever the facts, never empty", () => {
        const plain = new Variant(facts);
        const other = new Variant({
          ...Object.fromEntries(Object.keys(facts).map((k) => [k, "x"])),
        });

        expect(plain.message.length).toBeGreaterThan(10);
        expect(plain.message).toBe(other.message);
        expect(new Variant({ ...facts, message: "mine" }).message).toBe("mine");
      });

      it("keeps its facts as own fields, and its record names the family's line", () => {
        const error = new Variant(facts);

        for (const [key, value] of Object.entries(facts)) expect(error).toHaveProperty(key, value);
        expect(errorRecordOf(error)).toMatchObject({
          name: `${familyName}.${variantName}`,
          code: Variant.code,
          lineage: [Variant.code, family.code, "agboss"],
        });
      });
    });
  });
});

describe("#1325a: the spend of a paid family", () => {
  const usage = [
    {
      caller: "agent:buyer",
      model: "m",
      provider: "p",
      costUsd: usd(0.25),
      costSource: root.CostSource.Api,
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
  ] as const;

  it.each([
    [
      "StepError.Agent",
      () =>
        new root.StepError.Agent({
          agent: "a",
          nodeId: "a",
          visitNumber: 1,
          component: bareRecordOf("a", ComponentKind.Agent),
          usage,
        }),
    ],
    [
      "LimitError.Visits",
      () =>
        new root.LimitError.Visits({
          nodeId: "a",
          limit: 1,
          actual: 2,
          path: [],
          spentUsd: usd(0.25),
          usage,
        }),
    ],
    ["GuardrailError.Failed", () => new root.GuardrailError.Failed({ guardrail: "g", usage })],
    ["PiiError.DetectionFailed", () => new root.PiiError.DetectionFailed({ usage })],
  ])("%s carries its usage and the report of it", (_name, make) => {
    const error = make();

    expect(error.usage).toBe(usage);
    expect(error.spend.totalUsd).toBeCloseTo(0.25, 9);
    expect(error.spend.calls).toBe(1);
  });

  it("an error made without usage spent nothing", () => {
    const error = new root.PiiError.Refused({ piiKind: "email", refusal: "refused" });

    expect(error.usage).toEqual([]);
    expect(error.spend.totalUsd).toBe(0);
  });
});

describe("#1325a: StoreError.of builds the variant of a kind for the store packages", () => {
  it("makes a genuine StoreError of the kind, with its facts, a cause and its own sentence", () => {
    const cause = new Error("the driver said no");

    const error = stores.StoreError.of(stores.StoreErrorKind.SchemaTooNew, { cause, message: "m" });

    expect(error).toBeInstanceOf(stores.StoreError);
    expect(error).toBeInstanceOf(stores.StoreError.SchemaTooNew);
    expect(error).toBeInstanceOf(AGBossError);
    expect(error.kind).toBe(stores.StoreErrorKind.SchemaTooNew);
    expect(error.cause).toBe(cause);
    expect(error.message).toBe("m");
  });

  it("every kind has its variant: of() and the constructor make the same class", () => {
    for (const kind of Object.values(stores.StoreErrorKind))
      expect(stores.StoreError.of(kind, {}).constructor.name).toMatch(/^StoreError\./);
  });

  it("a kind that is none fails closed with a TypeError", () => {
    const wrong = "nope" as stores.StoreErrorKind;

    expect(() => stores.StoreError.of(wrong, {})).toThrow(TypeError);
  });
});
