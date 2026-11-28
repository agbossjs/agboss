/**
 * #1356 (spend shard) — the record of a call a provider billed and nobody could price, and the mark a fallback leaves:
 * the tokens it used at 0 USD as `unpriced`, under the model and the provider that served it — the fallback's when one
 * did, else the settings' —, the host that served it when the provider says, and a mark read only as far as it is one.
 */
import { describe, expect, it } from "vitest";
import { CostSource, NO_PROVIDER, unpricedUsageOf } from "../../src/finops/usage.js";
import { FALLBACK_MARK, fallbackMarkOf } from "../../src/finops/fallback-mark.js";
import { SERVED_BY_FIELD } from "../../src/finops/served-by.js";

const tokens = {
  input_tokens: 100,
  output_tokens: 40,
  input_token_details: { cache_read: 10, cache_creation: 5 },
};
const message = (usage: Record<string, unknown> = {}) => ({
  usage_metadata: tokens,
  response_metadata: { usage },
});

describe("#1356: the record of a call that could not be priced", () => {
  it("is its tokens at 0 USD, unpriced, under the settings' model and provider", () => {
    const record = unpricedUsageOf(
      "agent:clerk",
      { model: "base/model", modelProvider: "acme" },
      message(),
    );

    expect(record).toStrictEqual({
      caller: "agent:clerk",
      model: "base/model",
      inputTokens: 100,
      outputTokens: 40,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      provider: "acme",
      costUsd: 0,
      costSource: CostSource.Unpriced,
    });
  });

  it("a model with no provider is of no provider", () => {
    expect(unpricedUsageOf("agent:clerk", { model: "m" }, message()).provider).toBe(NO_PROVIDER);
  });

  it("the host that served it is kept when the provider names one, and no such field when it does not", () => {
    const served = unpricedUsageOf(
      "c",
      { model: "m" },
      message({ [SERVED_BY_FIELD]: "Fireworks" }),
    );
    const unserved = unpricedUsageOf("c", { model: "m" }, message({ [SERVED_BY_FIELD]: "" }));

    expect(served.servedBy).toBe("Fireworks");
    expect(Object.keys(unserved)).not.toContain("servedBy");
  });

  it("a fallback that served it gives its model and its provider, never the primary's", () => {
    const record = unpricedUsageOf(
      "c",
      { model: "base/model", modelProvider: "acme" },
      message({ [FALLBACK_MARK]: { model: "backup/model", provider: "backup" } }),
    );

    expect(record.model).toBe("backup/model");
    expect(record.provider).toBe("backup");
  });

  it("a fallback that names no provider is of no provider, not of the primary's", () => {
    const record = unpricedUsageOf(
      "c",
      { model: "base/model", modelProvider: "acme" },
      message({ [FALLBACK_MARK]: { model: "backup/model" } }),
    );

    expect(record.model).toBe("backup/model");
    expect(record.provider).toBe(NO_PROVIDER);
  });
});

describe("#1356: the mark a fallback leaves in a response", () => {
  const usageOf = (mark: unknown) => ({ usage: { [FALLBACK_MARK]: mark } });

  it("is read as the model, the provider, what the earlier providers spent and whether the price and the cost were the fallback's", () => {
    const earlier = [{ chars: 8 }];

    expect(
      fallbackMarkOf(usageOf({ model: "m", provider: "p", earlier, priced: true, unpriced: true })),
    ).toStrictEqual({ provider: "p", earlier, model: "m", priced: true, unpriced: true });
  });

  it("a field that is not what it should be reads as none: no provider, no earlier shares, not priced, not unpriced", () => {
    expect(
      fallbackMarkOf(
        usageOf({ model: "m", provider: 5, earlier: "no", priced: "yes", unpriced: 1 }),
      ),
    ).toStrictEqual({
      provider: undefined,
      earlier: [],
      model: "m",
      priced: false,
      unpriced: false,
    });
  });

  it.each([
    ["no metadata", undefined],
    ["a usage that is no record", { usage: "x" }],
    ["a usage that is a list", { usage: [] }],
    ["no mark", { usage: {} }],
    ["a mark that is no record", usageOf("m")],
    ["a mark that is a list", usageOf([])],
    ["a mark with no model", usageOf({ provider: "p" })],
    ["a mark whose model is no text", usageOf({ model: 5 })],
  ])("%s is no fallback", (_why, metadata) => {
    expect(fallbackMarkOf(metadata as never)).toBeUndefined();
  });
});
