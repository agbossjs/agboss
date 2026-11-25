import { usd, type Usd } from "../../src/units/index.js";
/**
 * #1356 — one model call's usage record: the cost the provider reported, the fallback's, else tokens ×
 * the price; a call with none of them fails; the cost a tool reports and its caller.
 */
import { describe, expect, it } from "vitest";
import { FALLBACK_MARK } from "../../src/finops/fallback-mark.js";
import { SERVED_BY_FIELD } from "../../src/finops/served-by.js";
import {
  costOf,
  CostSource,
  recordReportedCost,
  recordToolCost,
  recordUsage,
  reportedCostOf,
  ZERO_USAGE,
  NO_PROVIDER,
} from "../../src/finops/usage.js";
import { ConfigError } from "../../src/core/error-families/config-errors.js";

const tokens = { usage_metadata: { input_tokens: 1_000_000, output_tokens: 500_000 } };
const price = { inputPerMillion: usd(2), outputPerMillion: usd(4) };

describe("#1356: the cost a provider reported", () => {
  const of = (usage: unknown) => reportedCostOf({ response_metadata: { usage } });

  it("is the number of `usage.cost`, zero included", () => {
    expect(of({ cost: 0.25 })).toBe(0.25);
    expect(of({ cost: 0 })).toBe(0);
  });

  it("is none for a cost that is no amount, or a usage that holds none", () => {
    expect(of({ cost: -0.01 })).toBeUndefined();
    expect(of({ cost: Number.NaN })).toBeUndefined();
    expect(of({ cost: Number.POSITIVE_INFINITY })).toBeUndefined();
    expect(of({ cost: "0.25" })).toBeUndefined();
    expect(of({ cost: null })).toBeUndefined();
    expect(of({})).toBeUndefined();
    expect(of(null)).toBeUndefined();
    expect(of("cost")).toBeUndefined();
    expect(of(undefined)).toBeUndefined();
    expect(reportedCostOf({})).toBeUndefined();
  });
});

describe("#1356: one model call's record", () => {
  it("takes the provider's cost first, as `api`, with the tokens and no host when none is named", () => {
    const record = recordUsage(
      "writer",
      { model: "m/a", price },
      { ...tokens, response_metadata: { usage: { cost: 0.1 } } },
    );

    expect(record).toStrictEqual({
      caller: "writer",
      model: "m/a",
      provider: NO_PROVIDER,
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: usd(0.1),
      costSource: CostSource.Api,
    });
  });

  it("names the host that served the call when its answer does", () => {
    const record = recordUsage(
      "writer",
      { model: "m/a", price },
      { ...tokens, response_metadata: { usage: { cost: 0.1, [SERVED_BY_FIELD]: "DeepInfra" } } },
    );

    expect(record.servedBy).toBe("DeepInfra");
    expect(
      recordUsage(
        "writer",
        { model: "m/a", price },
        {
          ...tokens,
          response_metadata: { usage: { [SERVED_BY_FIELD]: "DeepInfra" } },
        },
      ).servedBy,
    ).toBe("DeepInfra");
  });

  it("prices the tokens by the table when the provider reported no cost", () => {
    const record = recordUsage("writer", { model: "m/a", price }, tokens);

    expect(record).toStrictEqual({
      caller: "writer",
      model: "m/a",
      provider: NO_PROVIDER,
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: usd(4),
      costSource: CostSource.PriceTable,
    });
  });

  it("accounts a fallback's call under the fallback's model: its reported cost, `api` or `price-table` as marked", () => {
    const answered = (priced: boolean) => ({
      ...tokens,
      response_metadata: {
        usage: {
          cost: 0.3,
          [FALLBACK_MARK]: { model: "backup/m", priced },
          [SERVED_BY_FIELD]: "Together",
        },
      },
    });

    expect(recordUsage("writer", { model: "m/a", price }, answered(false))).toStrictEqual({
      caller: "writer",
      model: "backup/m",
      provider: NO_PROVIDER,
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: usd(0.3),
      costSource: CostSource.Api,
      servedBy: "Together",
    });
    expect(recordUsage("writer", { model: "m/a", price }, answered(true)).costSource).toBe(
      CostSource.PriceTable,
    );
  });

  it("a fallback's call with no reported cost fails, and is never priced by the primary's table", () => {
    const answered = {
      ...tokens,
      response_metadata: { usage: { [FALLBACK_MARK]: { model: "backup/m", priced: true } } },
    };

    expect(() => recordUsage("writer", { model: "m/a", price }, answered)).toThrow(
      ConfigError.ModelCost,
    );
    expect(() => recordUsage("writer", { model: "m/a", price }, answered)).toThrow(
      "writer: fallback model backup/m — no cost and no price",
    );
  });

  it("a call with neither a reported cost nor a price fails", () => {
    expect(() => recordUsage("writer", { model: "m/a" }, tokens)).toThrow(ConfigError.ModelCost);
    expect(() => recordUsage("writer", { model: "m/a" }, tokens)).toThrow(
      expect.objectContaining({ code: "config.model-cost", model: "m/a" }),
    );
    expect(() => recordUsage("writer", { model: "m/a" }, tokens)).toThrow(
      "writer: model m/a — its provider reported no cost and it has no price",
    );
  });

  it("a price that makes no amount is a ModelCost with its model and field; a tool's invalid cost is no ModelCost", () => {
    const nan = { usage_metadata: { input_tokens: Number.NaN, output_tokens: 1 } };

    expect(() => recordUsage("writer", { model: "m/a", price }, nan)).toThrow(
      expect.objectContaining({ code: "config.model-cost", model: "m/a", field: "price" }),
    );
    let tool: unknown;
    try {
      recordToolCost("search", Number.NaN);
    } catch (error) {
      tool = error;
    }
    expect(tool).toBeInstanceOf(ConfigError.Component);
    expect(tool).not.toBeInstanceOf(ConfigError.ModelCost);
  });

  it("tokens that price at no amount are never accounted", () => {
    const nan = { usage_metadata: { input_tokens: Number.NaN, output_tokens: 1 } };
    const negative = { usage_metadata: { input_tokens: 1, output_tokens: -9 } };

    expect(() => recordUsage("writer", { model: "m/a", price }, nan)).toThrow(
      "writer: model m/a — its tokens price at no amount: NaN",
    );
    expect(() =>
      recordUsage(
        "writer",
        { model: "m/a", price: { inputPerMillion: usd(1), outputPerMillion: usd(1) } },
        negative,
      ),
    ).toThrow("writer: model m/a — its tokens price at no amount: -0.000008");
    expect(
      recordUsage(
        "writer",
        { model: "m/a", price: { inputPerMillion: usd(0), outputPerMillion: usd(0) } },
        tokens,
      ).costUsd,
    ).toBe(0);
  });

  it("the errors are named", () => {
    expect(new ConfigError.Component({ message: "x" }).name).toBe("ConfigError.Component");
    expect(new ConfigError.ModelCost({ message: "x" }).name).toBe("ConfigError.ModelCost");
  });
});

describe("#1356: the cost a tool reports", () => {
  it("is a record of caller `tool:<name>`, at the cost, with no tokens", () => {
    expect(recordToolCost("search", 0.02)).toStrictEqual({
      caller: "tool:search",
      model: "search",
      provider: NO_PROVIDER,
      ...ZERO_USAGE,
      costUsd: usd(0.02),
      costSource: CostSource.Tool,
    });
    expect(recordToolCost("free", 0).costUsd).toBe(0);
  });

  it("an amount that is none fails, naming the tool and the amount", () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => recordToolCost("search", bad)).toThrow(
        `Tool "search" reported an invalid cost: ${String(bad)}`,
      );
  });

  it("is billed to the tool's cost caller when it has one", () => {
    expect(recordReportedCost({ name: "search" }, 0.5)).toStrictEqual(
      recordToolCost("search", 0.5),
    );
    expect(recordReportedCost({ name: "lookup", costCaller: "rag:kb" }, 0.5)).toStrictEqual({
      ...recordToolCost("lookup", 0.5),
      caller: "rag:kb",
    });
  });
});

describe("#1385: a price that is no amount from 0 never costs a call", () => {
  const FIELDS = [
    "inputPerMillion",
    "outputPerMillion",
    "cacheReadPerMillion",
    "cacheWritePerMillion",
  ] as const;
  const BAD = [-1, Number.NaN, Number.POSITIVE_INFINITY, "5", null, -0.000001];

  it.each(BAD)("a %s price field throws before a cost is recorded", (value) => {
    for (const field of FIELDS) {
      const bad = { ...price, [field]: value };
      expect(() => costOf(ZERO_USAGE, bad)).toThrow(ConfigError.Unit);
      expect(() => recordUsage("w", { model: "secret-model", price: bad }, tokens)).toThrow(
        new RegExp(
          `^\\[model\\.price-invalid\\] ${field} is .*, not a finite number of dollars from 0`,
        ),
      );
      expect(() => recordUsage("w", { model: "secret-model", price: bad }, tokens)).not.toThrow(
        /secret-model/,
      );
    }
  });

  it("a negative input price cannot offset a positive output price (the issue's $0.0005)", () => {
    const call = { usage_metadata: { input_tokens: 100, output_tokens: 1000 } };
    expect(() =>
      recordUsage(
        "w",
        { model: "m", price: { inputPerMillion: -5 as Usd, outputPerMillion: usd(1) } },
        call,
      ),
    ).toThrow(ConfigError.Unit);
  });

  it("a missing input or output price throws, a missing cache price does not", () => {
    expect(() => costOf(ZERO_USAGE, { outputPerMillion: usd(1) } as never)).toThrow(
      /inputPerMillion is undefined/,
    );
    expect(() => costOf(ZERO_USAGE, { inputPerMillion: usd(1) } as never)).toThrow(
      /outputPerMillion is undefined/,
    );
    expect(costOf(ZERO_USAGE, { inputPerMillion: usd(0), outputPerMillion: usd(0) })).toBe(0);
    expect(
      costOf(ZERO_USAGE, { ...price, cacheReadPerMillion: usd(0), cacheWritePerMillion: usd(0) }),
    ).toBe(0);
  });

  it("names a value by its kind, never its text", () => {
    expect(() => costOf(ZERO_USAGE, { ...price, inputPerMillion: "sk-secret" as never })).toThrow(
      /inputPerMillion is a string,/,
    );
  });
});
