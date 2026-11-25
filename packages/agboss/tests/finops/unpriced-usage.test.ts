import { ConfigError } from "../../src/core/error-families/config-errors.js";
/**
 * #1313b: a provider with no `cost` is unpriced — its call is recorded at 0 USD with its tokens
 * (`CostSource.Unpriced`) and the provider's name, never dropped; any other call with no cost and
 * no price still fails closed.
 */
import { describe, expect, it } from "vitest";
import { CostReport, CostSource, recordUsage, tokensOf } from "../../src/finops/usage.js";
import { FALLBACK_MARK } from "../../src/finops/fallback-mark.js";
import { usd } from "../../src/units/index.js";
import { applicationOf } from "../../src/application/assemble.js";
import { UnpricedApplication, PricedModels } from "./fixtures/unpriced.workflow.js";

const tokens = { usage_metadata: { input_tokens: 700, output_tokens: 300 } };

describe("#1313b: an unpriced call", () => {
  it("is recorded at 0 USD with its tokens and its provider", () => {
    const record = recordUsage(
      "writer",
      { model: "m/a", modelProvider: "agy-models", unpriced: true },
      tokens,
    );

    expect(record).toMatchObject({
      costUsd: usd(0),
      costSource: CostSource.Unpriced,
      provider: "agy-models",
      inputTokens: 700,
      outputTokens: 300,
    });
    expect(tokensOf(record)).toBe(1000);
  });

  it("a reported cost still wins, and a price still prices it", () => {
    const reported = recordUsage(
      "writer",
      { model: "m/a", modelProvider: "p", unpriced: true },
      { ...tokens, response_metadata: { usage: { cost: 0.5 } } },
    );
    const priced = recordUsage(
      "writer",
      {
        model: "m/a",
        modelProvider: "p",
        price: { inputPerMillion: usd(1_000), outputPerMillion: usd(0) },
      },
      tokens,
    );

    expect(reported).toMatchObject({
      costSource: CostSource.Api,
      costUsd: usd(0.5),
      provider: "p",
    });
    expect(priced).toMatchObject({ costSource: CostSource.PriceTable, provider: "p" });
  });

  it("a call with no cost, no price and a provider that has a cost fails closed", () => {
    expect(() => recordUsage("writer", { model: "m/a", modelProvider: "p" }, tokens)).toThrow(
      ConfigError.ModelCost,
    );
  });

  it("an unpriced fallback is recorded unpriced, not failed", () => {
    const record = recordUsage(
      "writer",
      { model: "m/a", modelProvider: "p" },
      {
        ...tokens,
        response_metadata: {
          usage: { [FALLBACK_MARK]: { model: "m/b", priced: false, unpriced: true } },
        },
      },
    );

    expect(record).toMatchObject({
      model: "m/b",
      costSource: CostSource.Unpriced,
      costUsd: usd(0),
    });
  });

  it("is in the report: counted as a call, its tokens summed, by provider", () => {
    const report = CostReport.fromUsage([
      recordUsage("a", { model: "m/a", modelProvider: "agy-models", unpriced: true }, tokens),
      recordUsage(
        "b",
        { model: "m/b", modelProvider: "paid-models" },
        { ...tokens, response_metadata: { usage: { cost: 0.25 } } },
      ),
    ]);

    expect(report.calls).toBe(2);
    expect(report.totalTokens).toBe(2000);
    expect(report.totalUsd).toBe(0.25);
    expect(report.byProvider).toEqual({ "agy-models": usd(0), "paid-models": usd(0.25) });
  });
});

describe("#1313b: the cascade marks the models of a provider with no cost", () => {
  it("an agent on it carries its provider and unpriced; one on a priced provider does not", async () => {
    const { workflows } = await applicationOf(UnpricedApplication);
    const agents = Object.assign(
      {},
      ...workflows.map((workflow) => workflow.config.agents),
    ) as Record<string, unknown>;

    expect(agents["free-agent"]).toMatchObject({
      modelProvider: "free-models",
      unpriced: true,
    });
    expect(agents["paid-agent"]).toMatchObject({ modelProvider: "priced-models" });
    expect(agents["paid-agent"]).not.toHaveProperty("unpriced");
    expect(PricedModels).toBeDefined();
  });
});
