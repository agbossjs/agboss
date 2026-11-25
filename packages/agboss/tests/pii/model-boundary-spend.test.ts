import { usd } from "../../src/units/index.js";
/**
 * #1366: what the model boundary's masking cost — the usage of every paid detection is on the reading
 * of a model called for an agent, and on the masked request, one record for each text it searched.
 */
import { HumanMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { CostSource, ZERO_USAGE, type UsageRecord } from "../../src/finops/usage.js";
import { maskForModel, modelReadingMaskOf } from "../../src/pii/model-boundary.js";
import type { PiiPolicySet } from "../../src/pii/policy-set.js";

const record = (costUsd: number, caller: string): UsageRecord => ({
  provider: "test-provider",
  ...ZERO_USAGE,
  caller,
  model: "m",
  costUsd: usd(costUsd),
  costSource: CostSource.Api,
});

/** A policy set whose every search costs a record named after the text, and refuses nothing. */
const costing = (): PiiPolicySet =>
  ({
    isEmpty: false,
    maskCacheKeyOf: (text: string) => text,
    mask: (text: string) =>
      Promise.resolve({
        masked: { text, blocked: [], tokens: {} },
        usage: [record(0.125, `detect:${text}`)],
      }),
    refusalError: () => Promise.resolve(undefined),
  }) as never;

describe("#1366: the usage of the model boundary's masking", () => {
  it("a model's reading carries the usage of each of its texts, in order", async () => {
    const mask = modelReadingMaskOf(costing());

    const read = await mask?.(["first", "second", "third"]);

    expect(read?.usage.map((each) => each.caller)).toEqual([
      "detect:first",
      "detect:second",
      "detect:third",
    ]);
  });

  it("a masked request carries the usage of each of its messages", async () => {
    const masked = await maskForModel(
      costing(),
      [new HumanMessage("alpha"), new HumanMessage("beta")],
      {},
    );

    expect(masked.usage.map((each) => each.caller)).toEqual(["detect:alpha", "detect:beta"]);
  });
});
