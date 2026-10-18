import { describe, expect, it } from "vitest";
import { workflowOf } from "../../src/testing/index.js";
import { ModelCostError, recordUsage } from "../../src/finops/usage.js";
import { ModelCost } from "../../src/models/index.js";
import { costLabel, priceOf } from "../../src/models/cost.js";
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

    expect(record).toMatchObject({ costUsd: 0.0123, costSource: "api" });
  });

  it("AC6: without a reported cost, tokens × the price table (price-table)", () => {
    const price = priceOf(
      ModelCost.fromPrices({
        "local/llama": { inputPerMillion: usd(1), outputPerMillion: usd(2) },
      }),
      "local/llama",
    );

    expect(recordUsage("summariser", { model: "local/llama", price }, tokens)).toMatchObject({
      costUsd: 3,
      costSource: "price-table",
    });
  });

  it("AC6: a call with neither a reported cost nor a price cannot be accounted", () => {
    expect(() => recordUsage("writer", { model: "x/y" }, tokens)).toThrow(ModelCostError);
  });

  it("AC6: a provider's price table prices the models that set none; fromResponse prices none", async () => {
    const bundle = await workflowOf(Priced);
    const priced = withProviderPrices(bundle.config, directoryOf(bundle.modelProviders));

    expect(priced.agents["summariser-agent"]?.price).toEqual({
      inputPerMTok: 1,
      outputPerMTok: 2,
      cacheReadPerMTok: 0.5,
    });
    expect(priced.agents["writer-agent"]?.price).toBeUndefined();
    expect(priceOf(ModelCost.fromResponse(), "x")).toBeUndefined();
    expect(priceOf(ModelCost.fromPrices({}), "x")).toBeUndefined();
    expect(costLabel(ModelCost.fromResponse())).toBe("cost from the response");
  });
});

describe("AC6: limits per run use the providers' cost", () => {
  test("a run's spend counts both sources, and crossing limits.perRun.cost fails the run", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(Summariser).thenReturn(
      replyWith(SummaryDto, { text: "short" }, { cost: usd(0.01) }),
      replyWith(SummaryDto, { text: "long" }, { cost: usd(0.06) }),
    );
    mockLlm(Writer).thenReturn(replyWith("done", { cost: usd(0.02) }));

    const result = await execute(app, TaskStart, { text: "go" });
    expect(result.spend.totalUsd).toBeCloseTo(0.03, 6);
    expect(result.spend.trace.map((line) => [line.caller, line.costSource])).toEqual([
      ["summariser-agent", "price-table"],
      ["writer-agent", "api"],
    ]);

    const overRun = execute(app, TaskStart, { text: "again" });
    await expect(overRun).rejects.toFailWith({ code: "limits.perRun.cost" });
  });
});
