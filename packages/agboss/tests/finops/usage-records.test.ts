/**
 * #1356 — one model call's usage record: the cost the provider reported, the fallback's, else tokens ×
 * the price; a call with none of them fails; the cost a tool reports and its caller.
 */
import { describe, expect, it } from "vitest";
import { FALLBACK_MARK } from "../../src/finops/fallback-mark.js";
import { SERVED_BY_FIELD } from "../../src/finops/served-by.js";
import {
  CostSource,
  InvalidToolCostError,
  ModelCostError,
  recordReportedCost,
  recordToolCost,
  recordUsage,
  reportedCostOf,
  ZERO_USAGE,
} from "../../src/finops/usage.js";

const tokens = { usage_metadata: { input_tokens: 1_000_000, output_tokens: 500_000 } };
const price = { inputPerMTok: 2, outputPerMTok: 4 };

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
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.1,
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
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 4,
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
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.3,
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

    expect(() => recordUsage("writer", { model: "m/a", price }, answered)).toThrow(ModelCostError);
    expect(() => recordUsage("writer", { model: "m/a", price }, answered)).toThrow(
      "writer: fallback model backup/m — no cost and no price",
    );
  });

  it("a call with neither a reported cost nor a price fails", () => {
    expect(() => recordUsage("writer", { model: "m/a" }, tokens)).toThrow(ModelCostError);
    expect(() => recordUsage("writer", { model: "m/a" }, tokens)).toThrow(
      "writer: model m/a — its provider reported no cost and it has no price",
    );
  });

  it("tokens that price at no amount are never accounted", () => {
    const nan = { usage_metadata: { input_tokens: Number.NaN, output_tokens: 1 } };
    const negative = { usage_metadata: { input_tokens: 1, output_tokens: 1 } };

    expect(() => recordUsage("writer", { model: "m/a", price }, nan)).toThrow(
      "writer: model m/a — its tokens price at no amount: NaN",
    );
    expect(() =>
      recordUsage(
        "writer",
        { model: "m/a", price: { inputPerMTok: -9, outputPerMTok: 1 } },
        negative,
      ),
    ).toThrow("writer: model m/a — its tokens price at no amount: -0.000008");
    expect(
      recordUsage("writer", { model: "m/a", price: { inputPerMTok: 0, outputPerMTok: 0 } }, tokens)
        .costUsd,
    ).toBe(0);
  });

  it("the errors are named", () => {
    expect(new ModelCostError("x").name).toBe("ModelCostError");
    expect(new InvalidToolCostError("x").name).toBe("InvalidToolCostError");
  });
});

describe("#1356: the cost a tool reports", () => {
  it("is a record of caller `tool:<name>`, at the cost, with no tokens", () => {
    expect(recordToolCost("search", 0.02)).toStrictEqual({
      caller: "tool:search",
      model: "search",
      ...ZERO_USAGE,
      costUsd: 0.02,
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
