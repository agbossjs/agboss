import { LimitError } from "../../src/core/error-families/limit-errors.js";
import { describe, expect, it } from "vitest";
import { workflowOf } from "../../src/testing/workflow-of.js";
import { recordUsage } from "../../src/finops/usage.js";
import { ModelCost } from "../../src/models/index.js";
import {
  costLabel,
  modelPriceProblemOf,
  modelPricesProblemOf,
  priceOf,
} from "../../src/models/cost.js";
import { directoryOf, withProviderPrices } from "../../src/models/workflow-models.js";
import { replyWith, testWith } from "../../src/testing/index.js";
import { usd } from "../../src/units/index.js";
import {
  Priced,
  Summariser,
  SummaryDto,
  TaskStart,
  Writer,
  PricedApplication,
} from "./fixtures/priced.workflow.js";
import { execute } from "../helpers/flow.js";
import { ConfigError } from "../../src/core/error-families/config-errors.js";

const test = testWith(PricedApplication);
const tokens = { usage_metadata: { input_tokens: 1_000_000, output_tokens: 1_000_000 } };

describe("AC6: cost — from the provider's response, a price table as the fallback", () => {
  it("AC6: the cost the provider reports in its replyWith is the call's cost (api)", () => {
    const record = recordUsage(
      "writer",
      { model: "moonshotai/kimi-k2.6" },
      {
        ...tokens,
        response_metadata: { usage: { cost: 0.0123 } },
      },
    );

    expect(record).toMatchObject({ costUsd: usd(0.0123), costSource: "api" });
  });

  it("AC6: without a reported cost, tokens × the price table (price-table)", () => {
    const price = priceOf(
      ModelCost.fromPrices({
        "local/llama": { inputPerMillion: usd(1), outputPerMillion: usd(2) },
      }),
      "local/llama",
    );

    expect(recordUsage("summariser", { model: "local/llama", price }, tokens)).toMatchObject({
      costUsd: usd(3),
      costSource: "price-table",
    });
  });

  it("AC6: a call with neither a reported cost nor a price cannot be accounted", () => {
    expect(() => recordUsage("writer", { model: "x/y" }, tokens)).toThrow(ConfigError.ModelCost);
  });

  it("AC6: a provider's price table prices the models that set none; fromResponse prices none", async () => {
    const bundle = await workflowOf(Priced);
    const priced = withProviderPrices(bundle.config, directoryOf(bundle.modelProviders));

    expect(Reflect.get(priced.agents["summariser-agent"] ?? {}, "price")).toEqual({
      inputPerMillion: usd(1),
      outputPerMillion: usd(2),
      cacheReadPerMillion: usd(0.5),
    });
    expect(Reflect.get(priced.agents["writer-agent"] ?? {}, "price")).toBeUndefined();
    expect(priceOf(ModelCost.fromResponse(), "x")).toBeUndefined();
    expect(priceOf(ModelCost.fromPrices({}), "x")).toBeUndefined();
    expect(costLabel(ModelCost.fromResponse())).toBe("cost from the response");
  });
});

describe("AC6: limits per run use the providers' cost", () => {
  test("a run's spend counts both sources, and crossing the execution budget fails the run", async ({
    app,
    mockModel,
  }) => {
    mockModel(Summariser).thenReturn(
      replyWith(SummaryDto, { text: "short" }, { cost: usd(0.01) }),
      replyWith(SummaryDto, { text: "long" }, { cost: usd(0.06) }),
    );
    mockModel(Writer).thenReturn(replyWith("done", { cost: usd(0.02) }));

    const result = await execute(app, TaskStart, { text: "go" });
    expect(result.spend.totalUsd).toBeCloseTo(0.03, 6);
    expect(result.spend.trace.map((line) => [line.caller, line.costSource])).toEqual([
      ["summariser-agent", "price-table"],
      ["writer-agent", "api"],
    ]);

    const overRun = execute(app, TaskStart, { text: "again" });
    await expect(overRun).rejects.toFailWith(LimitError.Budget, {
      budget: { name: "priced-execution-budget" },
    });
  });
});

describe("#1382, #1385: a price table holds finite prices from 0", () => {
  const entry = (field: string, value: unknown) =>
    ({ inputPerMillion: usd(1), outputPerMillion: usd(2), [field]: value }) as never;
  const table = (field: string, value: unknown) => ({ "local/llama": entry(field, value) });
  const BAD = [-1, Number.NaN, Number.POSITIVE_INFINITY, "five", null, {}, -0.000001];
  const FIELDS = [
    "inputPerMillion",
    "outputPerMillion",
    "cacheReadPerMillion",
    "cacheWritePerMillion",
  ];

  it.each(BAD)("a %s price is refused when the table is made, naming the field only", (value) => {
    for (const field of FIELDS) {
      expect(() => ModelCost.fromPrices(table(field, value))).toThrow(ConfigError.Unit);
      expect(() => ModelCost.fromPrices(table(field, value))).toThrow(
        new RegExp(
          `^\\[model\\.price-invalid\\] ${field} is .*, not a finite number of dollars from 0`,
        ),
      );
    }
  });

  it("names a value by its kind, never its text, and never the model", () => {
    const message = (build: () => unknown): string => {
      try {
        build();
      } catch (error) {
        return (error as Error).message;
      }
      return "";
    };
    const secret = message(() => ModelCost.fromPrices(table("inputPerMillion", "sk-secret-text")));
    expect(secret).toBe(
      "[model.price-invalid] inputPerMillion is a string, not a finite number of dollars from 0 (usd(...))",
    );
    expect(secret).not.toContain("llama");
    expect(message(() => ModelCost.fromPrices(table("inputPerMillion", -1)))).toContain("is -1,");
    expect(message(() => ModelCost.fromPrices(table("inputPerMillion", {})))).toContain(
      "is an object,",
    );
  });

  it("a missing input or output price is refused, a missing cached price is not", () => {
    expect(() => ModelCost.fromPrices({ m: { outputPerMillion: usd(1) } as never })).toThrow(
      /inputPerMillion is undefined/,
    );
    expect(() => ModelCost.fromPrices({ m: { inputPerMillion: usd(1) } as never })).toThrow(
      /outputPerMillion is undefined/,
    );
    expect(() =>
      ModelCost.fromPrices({ m: { inputPerMillion: usd(1), outputPerMillion: usd(1) } }),
    ).not.toThrow();
  });

  it("an entry that is no object, and a table that is none, are refused", () => {
    expect(() => ModelCost.fromPrices({ m: null as never })).toThrow(
      /a price table entry is null, not a price object/,
    );
    expect(() => ModelCost.fromPrices({ m: "x" as never })).toThrow(/entry is a string/);
    expect(() => ModelCost.fromPrices(null as never)).toThrow(
      /the price table is null, not an object of prices/,
    );
    expect(() => ModelCost.fromPrices("x" as never)).toThrow(/the price table is a string/);
  });

  it("takes 0 and an absent cached price", () => {
    const cost = ModelCost.fromPrices({
      "a/b": { inputPerMillion: usd(0), outputPerMillion: usd(0) },
      "c/d": { inputPerMillion: usd(1), outputPerMillion: usd(2), cacheReadPerMillion: usd(0) },
    });
    expect(priceOf(cost, "c/d")).toEqual({
      inputPerMillion: usd(1),
      outputPerMillion: usd(2),
      cacheReadPerMillion: usd(0),
    });
    expect(priceOf(cost, "a/b")).toEqual({ inputPerMillion: usd(0), outputPerMillion: usd(0) });
  });

  it("the table keeps its own frozen copy of each entry: the caller's object cannot change it", () => {
    const mine = { inputPerMillion: usd(1), outputPerMillion: usd(2), extra: "x" };
    const cost = ModelCost.fromPrices({ m: mine });
    (mine as { inputPerMillion: number }).inputPerMillion = -5;
    expect(priceOf(cost, "m")).toEqual({ inputPerMillion: usd(1), outputPerMillion: usd(2) });
    if (cost.kind !== "from-prices") throw new Error("not a table");
    expect(Object.isFrozen(cost.prices)).toBe(true);
    expect(Object.isFrozen(cost.prices.m)).toBe(true);
    expect(cost.prices.m).not.toBe(mine);
    expect(cost.prices.m).toEqual({ inputPerMillion: 1, outputPerMillion: 2 });
    expect(Object.keys(cost.prices.m as object)).toEqual(["inputPerMillion", "outputPerMillion"]);
    expect(() => {
      (cost.prices.m as { inputPerMillion: number }).inputPerMillion = -5;
    }).toThrow(TypeError);
  });

  it("a literal ModelCost with a bad price is refused at its use, before any cost", () => {
    for (const value of BAD) {
      for (const field of FIELDS) {
        const literal: ModelCost = { kind: "from-prices", prices: table(field, value) };
        expect(() => priceOf(literal, "local/llama")).toThrow(ConfigError.Unit);
        expect(() => priceOf(literal, "local/llama")).toThrow(
          new RegExp(`^\\[model\\.price-invalid\\] ${field} is `),
        );
        expect(priceOf(literal, "other/model")).toBeUndefined();
      }
    }
  });

  it("the issue's repro: a negative input price never lowers a recorded cost", () => {
    const literal: ModelCost = {
      kind: "from-prices",
      prices: { m: { inputPerMillion: -5 as never, outputPerMillion: usd(1) } },
    };
    const call = { usage_metadata: { input_tokens: 100, output_tokens: 1000, total_tokens: 1100 } };
    expect(() => recordUsage("w", { model: "m", price: priceOf(literal, "m") }, call)).toThrow(
      ConfigError.Unit,
    );
  });

  it("a table changed after it was checked is refused at its next use", () => {
    const mutable = { m: { inputPerMillion: usd(1), outputPerMillion: usd(1) } };
    const literal: ModelCost = { kind: "from-prices", prices: mutable };
    expect(priceOf(literal, "m")).toEqual({ inputPerMillion: usd(1), outputPerMillion: usd(1) });
    (mutable.m as { inputPerMillion: number }).inputPerMillion = -5;
    expect(() => priceOf(literal, "m")).toThrow(/\[model\.price-invalid\] inputPerMillion is -5,/);
  });

  it("a literal whose table is none is refused at its use", () => {
    expect(() => priceOf({ kind: "from-prices", prices: null as never }, "m")).toThrow(
      /\[model\.price-invalid\] the price table is null, not an object of prices/,
    );
  });

  it("only a model the table lists has a price: a name of Object.prototype has none", () => {
    const cost = ModelCost.fromPrices({ m: { inputPerMillion: usd(1), outputPerMillion: usd(1) } });
    expect(priceOf(cost, "constructor")).toBeUndefined();
    expect(priceOf(cost, "toString")).toBeUndefined();
  });

  it("modelPricesProblemOf is none for a good table and the first problem otherwise", () => {
    expect(modelPricesProblemOf({})).toBeUndefined();
    expect(modelPriceProblemOf({ inputPerMillion: 0, outputPerMillion: 0 })).toBeUndefined();
    expect(
      modelPricesProblemOf({
        a: { inputPerMillion: 1, outputPerMillion: 1 },
        b: { inputPerMillion: 1, outputPerMillion: -1 },
      }),
    ).toMatch(/^outputPerMillion is -1,/);
  });
});

describe("ModelPrice: a cached read is priced at cacheReadPerMillion, a cache write at cacheWritePerMillion", () => {
  const priced = ModelCost.fromPrices({
    "cache/model": {
      inputPerMillion: usd(3),
      outputPerMillion: usd(15),
      cacheReadPerMillion: usd(0.3),
      cacheWritePerMillion: usd(3.75),
    },
    "plain/model": { inputPerMillion: usd(3), outputPerMillion: usd(15) },
  });
  const carrier = {
    usage_metadata: {
      input_tokens: 1_000_000,
      output_tokens: 100_000,
      input_token_details: { cache_read: 600_000, cache_creation: 100_000 },
    },
  };
  const settingsOf = (model: string) => ({ model, price: priceOf(priced, model) });

  it("prices the tokens read from the cache at cacheRead, the written ones at cacheWrite, the rest at input", () => {
    const record = recordUsage("agent:a", settingsOf("cache/model"), carrier);
    // 300k uncached x 3 + 600k read x 0.3 + 100k written x 3.75 + 100k out x 15, per million
    expect(record.costUsd).toBeCloseTo(0.9 + 0.18 + 0.375 + 1.5, 10);
    expect(record.cacheReadTokens).toBe(600_000);
    expect(record.cacheWriteTokens).toBe(100_000);
  });

  it("a cache price left out is the input price", () => {
    const record = recordUsage("agent:a", settingsOf("plain/model"), carrier);
    expect(record.costUsd).toBeCloseTo(3 + 1.5, 10);
  });

  it("maps both cache prices into the call's price", () => {
    expect(priceOf(priced, "cache/model")).toEqual({
      inputPerMillion: usd(3),
      outputPerMillion: usd(15),
      cacheReadPerMillion: usd(0.3),
      cacheWritePerMillion: usd(3.75),
    });
  });
});
