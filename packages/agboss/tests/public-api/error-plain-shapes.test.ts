/**
 * #906 D1: the errors that are not `AGBossError`s keep what made them what they are — a
 * `RangeError` stays one, a test failure's message starts with its code, the store set's refusal
 * names its first problem's rule — and take one options object with a `cause`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AGBossError } from "../../src/index.js";
import {
  CassetteChange,
  StaleCassetteError,
  TestFailure,
  UnsettledWorkError,
} from "../../src/testing/index.js";
import { StoreConformanceError } from "../../src/testing/contracts/index.js";
import { usd } from "../../src/units/index.js";
import { ConfigError } from "../../src/core/error-families/config-errors.js";

describe("#906 D1: the platform classes stay", () => {
  it("a unit out of range is a ConfigError.Unit, an AGBossError that Result.try catches", () => {
    const cause = new Error("the amount came from a form");
    const error = new ConfigError.Unit({ message: "usd must be a finite number ≥ 0", cause });

    expect(error).toBeInstanceOf(AGBossError);
    expect(error).not.toBeInstanceOf(RangeError);
    expect(error).toMatchObject({ code: "config.unit", cause });
    expect(() => usd(-1)).toThrow(ConfigError.Unit);
  });

  it("an environment error's code is config.environment; its message names the rule", () => {
    const environment = new ConfigError.Environment({
      message: "[environment.missing-variable] STRIPE_KEY is not set",
    });

    expect(environment).toBeInstanceOf(AGBossError);
    expect(environment.code).toBe("config.environment");
    expect(environment.message).toContain("[environment.missing-variable]");
  });

  it("a test failure's message starts with its code; its subclasses carry their facts", () => {
    expect(new TestFailure({ code: "test.app-closed", message: "closed" }).message).toBe(
      "test.app-closed: closed",
    );
    const stale = new StaleCassetteError({
      file: "a.json",
      component: "Clerk",
      changes: [CassetteChange.Prompt, CassetteChange.Schema],
    });
    expect(stale).toMatchObject({ code: "vcr.stale-cassette", file: "a.json", component: "Clerk" });
    expect(stale.message).toContain("changed since it was recorded (prompt, schema)");
    expect(new UnsettledWorkError({ inFlight: 2, settleTimeout: 50 })).toMatchObject({
      inFlight: 2,
      settleTimeout: 50,
      isLoad: false,
    });
  });
});

/** Every `[store-conformance.<rule>]` tag the sources of the contracts' checks write. */
const RULES_IN_SOURCE = (): readonly string[] => {
  const dir = join(import.meta.dirname, "../../src/testing/contracts");
  const found = readdirSync(dir)
    .filter((file) => file.endsWith(".ts"))
    .flatMap((file) =>
      [...readFileSync(join(dir, file), "utf8").matchAll(/\[store-conformance\.([a-z-]+)\]/g)].map(
        (match) => match[1] ?? "",
      ),
    );
  return [...new Set(found)].sort();
};

describe("#906 D1: a refused store set names its first problem's rule", () => {
  it("every rule the checks write is a code the error carries", () => {
    const rules = RULES_IN_SOURCE();

    expect(rules.length).toBeGreaterThan(10);
    for (const rule of rules) {
      const error = new StoreConformanceError({ problems: [`[store-conformance.${rule}] x`] });
      expect(error.code).toBe(`store-conformance.${rule}`);
    }
  });

  it("a problem without a tag, or with none at all, is plain `store-conformance`", () => {
    expect(new StoreConformanceError({ problems: ["something"] }).code).toBe("store-conformance");
    expect(new StoreConformanceError({ problems: [] }).code).toBe("store-conformance");
    expect(new StoreConformanceError({ problems: ["[store-conformance.made-up] x"] }).code).toBe(
      "store-conformance",
    );
  });
});
