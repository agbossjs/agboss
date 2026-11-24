import { AIMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { CostSource } from "../../../src/finops/cost-source.js";
import { earlierUsageRecordsOf, partialUsageRecordsOf } from "../../../src/finops/partial-usage.js";
import { ModelCost } from "../../../src/models/index.js";
import { markedFallbackMessage } from "../../../src/models/fallback.js";
import {
  withFailoverTrace,
  withPartialSpend,
  type FallbackServer,
} from "../../../src/models/transport/stream-partial.js";
import { usd } from "../../../src/units/index.js";

/**
 * #1399: the partial spend of a call a fallback chain served is recorded under the provider, model
 * and price that served the chunks, each share apart, and never twice (a report and a count).
 */

const usage = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 };
const primary = {
  model: "primary/m",
  modelProvider: "primary-provider",
  price: { inputPerMTok: 1, outputPerMTok: 2 },
};
const backup: FallbackServer = {
  provider: "backup-provider",
  model: "backup/m",
  cost: ModelCost.fromPrices({
    "backup/m": { inputPerMillion: usd(10), outputPerMillion: usd(20) },
  }),
};
const unpricedBackup: FallbackServer = {
  provider: "free-provider",
  model: "free/m",
  cost: undefined,
};
const call = { requestChars: 40, answerChars: 20 };

describe("#1399: a fallback-served call's partial spend", () => {
  it("is recorded under the provider and model that served the chunks, at its price", () => {
    const error = withFailoverTrace(withPartialSpend(new Error("x"), { usage }), {
      server: backup,
      earlier: [],
    });

    const records = partialUsageRecordsOf("agent", primary, error, call);

    expect(records).toEqual([
      expect.objectContaining({
        provider: "backup-provider",
        model: "backup/m",
        inputTokens: 100,
        outputTokens: 50,
        costSource: CostSource.PriceTable,
        costUsd: (100 * 10 + 50 * 20) / 1_000_000,
      }),
    ]);
  });

  it("a fallback with no price is unpriced tokens under its own provider, never the primary's price", () => {
    const error = withFailoverTrace(new Error("x"), { server: unpricedBackup, earlier: [] });

    const records = partialUsageRecordsOf("agent", primary, error, call);

    expect(records).toEqual([
      expect.objectContaining({
        provider: "free-provider",
        model: "free/m",
        costUsd: 0,
        costSource: CostSource.Unpriced,
      }),
    ]);
  });

  it("the primary's chunks before the failover are its own share, the fallback's the rest", () => {
    const error = withFailoverTrace(new Error("x"), {
      server: backup,
      earlier: [{ chars: 8 }],
    });

    const records = partialUsageRecordsOf("agent", primary, error, call);

    expect(records).toHaveLength(2);
    expect(records[0]).toEqual(
      expect.objectContaining({
        model: "primary/m",
        provider: "primary-provider",
        outputTokens: 2,
      }),
    );
    expect(records[1]).toEqual(
      expect.objectContaining({ model: "backup/m", provider: "backup-provider", outputTokens: 3 }),
    ); // (20 - 8) chars: 3 tokens
  });

  it("a provider's report replaces its count: the two are never both recorded", () => {
    const error = withFailoverTrace(withPartialSpend(new Error("x"), { usage }), {
      server: backup,
      earlier: [{ chars: 8, reported: { usage: { ...usage, inputTokens: 7, outputTokens: 5 } } }],
    });

    const records = partialUsageRecordsOf("agent", primary, error, call);

    expect(
      records.map((record) => [record.model, record.inputTokens, record.outputTokens]),
    ).toEqual([
      ["primary/m", 7, 5],
      ["backup/m", 100, 50],
    ]);
  });

  it("no trace: the call's own provider and price, as before", () => {
    const records = partialUsageRecordsOf("agent", primary, new Error("x"), call);

    expect(records).toEqual([
      expect.objectContaining({
        model: "primary/m",
        provider: "primary-provider",
        outputTokens: 5,
      }),
    ]);
  });
});

describe("#1399: the earlier shares of a call a fallback answered", () => {
  it("are recorded under the failed provider, beside the answer's own record", () => {
    const answered = markedFallbackMessage(new AIMessage({ content: "ok" }), backup, [
      { chars: 8 },
    ]);

    const records = earlierUsageRecordsOf("agent", primary, answered.response_metadata, 40);

    expect(records).toEqual([
      expect.objectContaining({
        model: "primary/m",
        provider: "primary-provider",
        outputTokens: 2,
      }),
    ]);
  });

  it("a call served with no failed share before it has none", () => {
    const answered = markedFallbackMessage(new AIMessage({ content: "ok" }), backup);

    expect(earlierUsageRecordsOf("agent", primary, answered.response_metadata, 40)).toEqual([]);
  });
});
