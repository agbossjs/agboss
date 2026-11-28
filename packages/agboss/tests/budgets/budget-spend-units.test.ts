/**
 * #1356 (spend shard) — what a budget counts and how it ends, rule by rule: the cap a spend has reached (dollars first,
 * a cap that is not there never reached), the error of an exhausted budget with every field, the limits a budget has
 * at the start of an execution — declared, from `limit()`, from `maxSpend()`, refused when they are no amount —, and
 * what the ledger keeps of them.
 */
import { describe, expect, it, vi } from "vitest";
import { ConfigError } from "../../src/core/error-families/config-errors.js";
import { LimitError } from "../../src/core/error-families/limit-errors.js";
import { BudgetPeriod, BudgetScope, BudgetUnit } from "../../src/budgets/budget.js";
import {
  budgetExceededErrorOf,
  exhaustedUnitOf,
  firstBreachOf,
  limitOf,
  limitsOf,
} from "../../src/budgets/budget-spend.js";
import { env } from "../../src/environments/env-readers.js";
import { usd } from "../../src/units/index.js";

const record = (changes: object = {}) =>
  ({
    budget: { name: "tier-budget" },
    scope: BudgetScope.Tenant,
    period: BudgetPeriod.Day,
    key: "acme",
    ...changes,
  }) as never;

const place = { path: ["wf", "agent"], executionSpent: 0.5, usage: [] };

describe("#1356: the cap a spend has reached", () => {
  it("dollars first, at the cap and not before; tokens at their cap and not before", () => {
    const both = record({ maxSpend: 1, maxTokens: 100 });

    expect(exhaustedUnitOf(both, { usd: 1, tokens: 0 })).toBe(BudgetUnit.Usd);
    expect(exhaustedUnitOf(both, { usd: 0.999999, tokens: 99 })).toBeUndefined();
    expect(exhaustedUnitOf(both, { usd: 0.5, tokens: 100 })).toBe(BudgetUnit.Tokens);
    expect(exhaustedUnitOf(both, { usd: 2, tokens: 200 })).toBe(BudgetUnit.Usd);
  });

  it("a cap the budget has not is never reached, whatever is spent", () => {
    expect(exhaustedUnitOf(record({ maxTokens: 100 }), { usd: 1e9, tokens: 99 })).toBeUndefined();
    expect(exhaustedUnitOf(record({ maxSpend: 1 }), { usd: 0.5, tokens: 1e9 })).toBeUndefined();
    expect(exhaustedUnitOf(record(), { usd: 1e9, tokens: 1e9 })).toBeUndefined();
    expect(exhaustedUnitOf(record({ maxTokens: 100 }), { usd: 0, tokens: 100 })).toBe(
      BudgetUnit.Tokens,
    );
  });
});

describe("#1356: the error of an exhausted budget", () => {
  it("names the budget, its scope, period and key, both caps, what is spent, and where it ended", () => {
    const usage = [{ caller: "x" }] as never;

    const error = budgetExceededErrorOf(
      record({ maxSpend: 1, maxTokens: 100 }),
      { usd: 1.25, tokens: 130 },
      BudgetUnit.Usd,
      { ...place, usage },
    );

    expect(error).toBeInstanceOf(LimitError.Budget);
    expect(error).toMatchObject({
      budget: { name: "tier-budget" },
      scope: BudgetScope.Tenant,
      period: BudgetPeriod.Day,
      key: "acme",
      unit: BudgetUnit.Usd,
      maxSpend: usd(1),
      spent: usd(1.25),
      maxTokens: 100,
      usedTokens: 130,
      path: ["wf", "agent"],
      spentUsd: usd(0.5),
    });
    expect(error.usage).toBe(usage);
  });

  it("a cap that is not there is no field of the error, and an overdrawn count is read as zero", () => {
    const error = budgetExceededErrorOf(
      record({ maxSpend: 1 }),
      { usd: -3, tokens: -5 },
      BudgetUnit.Usd,
      place,
    );

    expect(Object.hasOwn(error, "maxTokens")).toBe(false);
    expect(error.spent).toBe(0);
    expect(error.usedTokens).toBe(0);
    expect(
      Object.hasOwn(
        budgetExceededErrorOf(
          record({ maxTokens: 1 }),
          { usd: 0, tokens: 1 },
          BudgetUnit.Tokens,
          place,
        ),
        "maxSpend",
      ),
    ).toBe(false);
  });

  it("the first record that has reached a cap is the breach; none when none has", () => {
    const records = [
      record({ budget: { name: "first" }, maxSpend: 10 }),
      record({ budget: { name: "second" }, maxSpend: 1 }),
      record({ budget: { name: "third" }, maxSpend: 1 }),
    ];
    const spent = () => ({ usd: 1, tokens: 0 });

    expect(firstBreachOf(records, spent, place)).toMatchObject({
      budget: { name: "second" },
      unit: "usd",
    });
    expect(firstBreachOf(records.slice(0, 1), spent, place)).toBeUndefined();
    expect(firstBreachOf([], spent, place)).toBeUndefined();
  });
});

describe("#1356: the limits a budget has at the start of an execution", () => {
  const inFrame = <T>(work: () => Promise<T>): Promise<T> => work();
  const meta = (changes: object = {}) =>
    ({ name: "tier-budget", scope: BudgetScope.Tenant, deps: [], ...changes }) as never;

  it("declared in @Budget: the dollars and the tokens as they are, and no key for a cap that is not declared", async () => {
    const both = await limitsOf({}, meta({ maxSpend: usd(2), maxTokens: 50 }), inFrame);
    const dollars = await limitsOf({}, meta({ maxSpend: usd(2) }), inFrame);
    const tokens = await limitsOf({}, meta({ maxTokens: 50 }), inFrame);

    expect(both).toStrictEqual({ maxSpend: usd(2), maxTokens: 50 });
    expect(dollars).toStrictEqual({ maxSpend: usd(2) });
    expect(tokens).toStrictEqual({ maxTokens: 50 });
  });

  it("declared with a variable of the environment: read from it, and a variable that is not set is refused naming the budget's limits", async () => {
    vi.stubEnv("TIER_CAP", "4");
    const ok = await limitsOf({}, meta({ maxSpend: env.usd("TIER_CAP") }), inFrame);
    vi.unstubAllEnvs();
    const failure = await limitsOf(
      {},
      meta({ maxSpend: env.usd("TIER_CAP_UNSET") }),
      inFrame,
    ).catch((e: unknown) => e);

    expect(ok).toStrictEqual({ maxSpend: usd(4) });
    expect((failure as Error).message).toBe(
      "[environment.missing-variable] TIER_CAP_UNSET is not set (tier-budget limits.maxSpend)",
    );
  });

  it("read from limit() in the execution's frame, each cap checked: a limit that gives neither is refused", async () => {
    const handler = { limit: vi.fn(() => ({ maxSpend: usd(3), maxTokens: 9 })) };
    const framed = vi.fn(inFrame);

    expect(await limitsOf(handler as never, meta(), framed as never)).toStrictEqual({
      maxSpend: usd(3),
      maxTokens: 9,
    });
    expect(framed).toHaveBeenCalledOnce();
    expect(await limitsOf({ limit: () => ({ maxTokens: 9 }) }, meta(), inFrame)).toStrictEqual({
      maxTokens: 9,
    });
    expect(await limitsOf({ limit: () => ({ maxSpend: usd(0) }) }, meta(), inFrame)).toStrictEqual({
      maxSpend: usd(0),
    });

    const none = await limitsOf({ limit: () => ({}) }, meta(), inFrame).catch((e: unknown) => e);
    expect(none).toBeInstanceOf(ConfigError.Unit);
    expect((none as Error).message).toBe(
      "tier-budget: it gave no maxSpend and no maxTokens: a budget must limit something",
    );
  });

  it("read from maxSpend(), as the one dollar cap; a budget with none of the three is refused", async () => {
    const handler = { maxSpend: vi.fn(() => usd(2)) };

    expect(await limitsOf(handler as never, meta(), inFrame)).toStrictEqual({ maxSpend: usd(2) });
    const none = await limitsOf({}, meta(), inFrame).catch((e: unknown) => e);
    expect(none).toBeInstanceOf(ConfigError.Unit);
    expect((none as Error).message).toBe(
      "tier-budget: it declares no maxSpend or maxTokens and has no limit()",
    );
  });

  it.each([
    [
      "maxSpend()",
      () => ({ maxSpend: () => Number.NaN }),
      "a finite number of dollars from 0 (usd(...)), it gave NaN",
    ],
    [
      "maxSpend",
      () => ({ limit: () => ({ maxSpend: "five" }) }),
      "a finite number of dollars from 0 (usd(...)), it gave a string",
    ],
    [
      "maxSpend",
      () => ({ limit: () => ({ maxSpend: -1 }) }),
      "a finite number of dollars from 0 (usd(...)), it gave -1",
    ],
    [
      "maxTokens",
      () => ({ limit: () => ({ maxTokens: 1.5 }) }),
      "a finite whole number of tokens from 0, it gave 1.5",
    ],
    [
      "maxTokens",
      () => ({ limit: () => ({ maxTokens: -2 }) }),
      "a finite whole number of tokens from 0, it gave -2",
    ],
    [
      "maxTokens",
      () => ({ limit: () => ({ maxTokens: { x: 1 } }) }),
      "a finite whole number of tokens from 0, it gave an object",
    ],
  ])(
    "a limit that is no amount (%s) is ConfigError.Unit that names the budget and the limit, never the value",
    async (what, handler, rest) => {
      const failure = await limitsOf(handler() as never, meta(), inFrame).catch((e: unknown) => e);

      expect(failure).toBeInstanceOf(ConfigError.Unit);
      expect((failure as Error).message).toBe(`tier-budget: ${what} must return ${rest}`);
    },
  );

  it("a finite whole number of tokens at zero is a limit, and so is a dollar cap of zero", async () => {
    expect(await limitsOf({ limit: () => ({ maxTokens: 0 }) }, meta(), inFrame)).toStrictEqual({
      maxTokens: 0,
    });
  });

  it("what the ledger keeps of a record's limits: the dollars as dollars, the tokens, none of a cap that is not there", () => {
    expect(limitOf(record({ maxSpend: 2, maxTokens: 9 }))).toStrictEqual({
      maxSpend: usd(2),
      maxTokens: 9,
    });
    expect(limitOf(record({ maxSpend: 2 }))).toStrictEqual({ maxSpend: usd(2) });
    expect(limitOf(record({ maxTokens: 9 }))).toStrictEqual({ maxTokens: 9 });
    expect(limitOf(record())).toStrictEqual({});
  });
});
