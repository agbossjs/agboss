/**
 * #1356 (stream shard) — what a call that failed mid-way had spent (#1399), rule by rule with exact records: a decision
 * that was answered and could not be used, a decision priced by its provider's table, the spend a failed streamed call
 * carries (its report, else counted from the chunks, split between a fallback chain's providers), the carriers of it
 * that follow an error's causes, and the counter of what a stream heard.
 */
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { describe, expect, it, vi } from "vitest";
import { ConfigError } from "../../src/core/error-families/config-errors.js";
import {
  billedDecisionRecord,
  decisionSpendOf,
  withDecisionSpend,
} from "../../src/finops/failed-decision.js";
import { pricedDecisionRecord } from "../../src/finops/decision-price.js";
import {
  earlierUsageRecordsOf,
  partialUsageRecordOf,
  partialUsageRecordsOf,
} from "../../src/finops/partial-usage.js";
import { CostSource, NO_PROVIDER, ZERO_USAGE, type UsageRecord } from "../../src/finops/usage.js";
import { FALLBACK_MARK } from "../../src/finops/fallback-mark.js";
import {
  ChunkCounter,
  earlierSpendOf,
  partialSpendOf,
  requestChars,
  withChunkCounter,
} from "../../src/graph/agent-loop/chunk-counter.js";
import { ModelCost } from "../../src/models/cost.js";
import {
  failoverTraceOf,
  partialSpendOf as partialSpendOfError,
  withFailoverTrace,
  withPartialSpend,
} from "../../src/models/transport/stream-partial.js";
import { usd } from "../../src/units/index.js";

const call = { caller: "decision:desk", model: "asked/model", provider: "acme" };

describe("#1356: a decision that was answered and could not be used", () => {
  it("a reported cost is the record's, as the provider counted its tokens, under the model that served it", () => {
    const record = billedDecisionRecord(
      call,
      { q: 1 },
      { model: "served/model", usage: { input_tokens: 10, output_tokens: 5, cost: 0.25 } },
    );

    expect(record).toStrictEqual({
      caller: "decision:desk",
      model: "served/model",
      ...ZERO_USAGE,
      inputTokens: 10,
      outputTokens: 5,
      provider: "acme",
      costUsd: usd(0.25),
      costSource: CostSource.Api,
    });
  });

  it("a cost of nothing reported is still a reported cost, and tokens it did not count are none", () => {
    const record = billedDecisionRecord(call, {}, { usage: { cost: 0 } });

    expect(record).toMatchObject({
      model: "asked/model",
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      costSource: CostSource.Api,
    });
  });

  it("no cost reported: the tokens as reported, else estimated from the sizes, unpriced", () => {
    const request = { text: "x".repeat(10) }; // {"text":"xxxxxxxxxx"} is 21 characters
    const answer = { text: "y".repeat(30) }; // 41 characters

    const estimated = billedDecisionRecord(call, request, answer);
    const partly = billedDecisionRecord(call, request, {
      usage: { input_tokens: 7 },
      extra: "y".repeat(30),
    });

    expect(estimated).toStrictEqual({
      caller: "decision:desk",
      model: "asked/model",
      ...ZERO_USAGE,
      inputTokens: 6,
      outputTokens: 11,
      provider: "acme",
      costUsd: 0,
      costSource: CostSource.Unpriced,
    });
    expect(partly.inputTokens).toBe(7);
    expect(partly.outputTokens).toBe(
      Math.ceil(JSON.stringify({ usage: { input_tokens: 7 }, extra: "y".repeat(30) }).length / 4),
    );
  });

  it("a call of no provider is of none; a size that cannot be told counts for nothing; an answer that is no report is estimated", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const record = billedDecisionRecord({ caller: "c", model: "m" }, circular, undefined);

    expect(record.provider).toBe(NO_PROVIDER);
    expect(record.inputTokens).toBe(0);
    expect(record.outputTokens).toBe(0);
    expect(billedDecisionRecord(call, "abcd", "abcdefgh")).toMatchObject({
      inputTokens: 2,
      outputTokens: 3,
    });
    expect(
      billedDecisionRecord(call, undefined, { usage: { input_tokens: -1, cost: 1 } }),
    ).toMatchObject({ costSource: CostSource.Unpriced });
  });

  it("is carried by the error, found through its causes, and a thrown text is wrapped so it is never dropped", () => {
    const record = billedDecisionRecord(call, {}, {});
    const own = new Error("own");
    const outer = new Error("outer", { cause: new Error("middle", { cause: own }) });

    expect(withDecisionSpend(own, record)).toBe(own);
    expect(decisionSpendOf(own)).toBe(record);
    expect(decisionSpendOf(outer)).toBe(record);
    const wrapped = withDecisionSpend("a text", record) as Error;
    expect(wrapped).toBeInstanceOf(Error);
    expect(wrapped.message).toBe("a text");
    expect(wrapped.cause).toBe("a text");
    expect(decisionSpendOf(wrapped)).toBe(record);
    expect(decisionSpendOf(new Error("none"))).toBeUndefined();
    expect(decisionSpendOf("text")).toBeUndefined();
    expect(decisionSpendOf({ cause: own })).toBeUndefined();
  });
});

describe("#1356: a decision priced by its provider's table", () => {
  const base: UsageRecord = {
    caller: "decision:desk",
    model: "answered/model",
    provider: "acme",
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: usd(0),
    costSource: CostSource.Unpriced,
  };
  const priced = (settings: object) => vi.fn(() => settings as never);

  it("a call with no pricing, or of no provider, or whose answer reported a cost, is as it was", () => {
    const pricing = priced({ price: { inputPerMillion: usd(1), outputPerMillion: usd(1) } });

    expect(pricedDecisionRecord(base, {}, "m", undefined)).toBe(base);
    expect(
      pricedDecisionRecord({ ...base, provider: NO_PROVIDER }, {}, "m", pricing),
    ).toMatchObject({ provider: NO_PROVIDER, costUsd: 0 });
    expect(pricedDecisionRecord(base, { usage: { cost: 0.5 } }, "m", pricing)).toBe(base);
    expect(pricedDecisionRecord(base, { usage: { total_cost: 0.5 } }, "m", pricing)).toBe(base);
    expect(pricedDecisionRecord(base, { usage: { cost: 0 } }, "m", pricing)).toBe(base);
    expect(pricing).not.toHaveBeenCalled();
  });

  it("priced by its provider's table for the model it asked, its tokens as the answer reported them", () => {
    const pricing = priced({
      price: { inputPerMillion: usd(1_000_000), outputPerMillion: usd(2_000_000) },
    });

    const record = pricedDecisionRecord(
      base,
      { usage: { input_tokens: 3, output_tokens: 4 } },
      "asked/model",
      pricing,
    );

    expect(pricing).toHaveBeenCalledWith({ model: "asked/model", modelProvider: "acme" });
    expect(record).toStrictEqual({
      ...base,
      inputTokens: 3,
      outputTokens: 4,
      costUsd: 11,
      costSource: CostSource.PriceTable,
    });
  });

  it("tokens the answer did not report are the record's own, one at a time", () => {
    const pricing = priced({
      price: { inputPerMillion: usd(1_000_000), outputPerMillion: usd(2_000_000) },
    });

    const inputOnly = pricedDecisionRecord(base, { usage: { input_tokens: 3 } }, "m", pricing);
    const outputOnly = pricedDecisionRecord(base, { usage: { output_tokens: 4 } }, "m", pricing);
    const noReport = pricedDecisionRecord(base, "no report", "m", pricing);

    expect([inputOnly.inputTokens, inputOnly.outputTokens]).toEqual([3, 50]);
    expect([outputOnly.inputTokens, outputOnly.outputTokens]).toEqual([100, 4]);
    expect([noReport.inputTokens, noReport.outputTokens, noReport.costUsd]).toEqual([100, 50, 200]);
  });

  it("a provider that has no cost leaves the call unpriced with its tokens; one with neither price nor mark leaves the record alone", () => {
    const unpriced = pricedDecisionRecord(
      base,
      { usage: { input_tokens: 3 } },
      "m",
      priced({ unpriced: true }),
    );
    const neither = pricedDecisionRecord(base, { usage: { input_tokens: 3 } }, "m", priced({}));

    expect(unpriced).toStrictEqual({
      ...base,
      inputTokens: 3,
      costUsd: 0,
      costSource: CostSource.Unpriced,
    });
    expect(neither).toBe(base);
  });
});

describe("#1356: the spend a failed streamed call carries", () => {
  it("is on the error itself, found through its causes; a thrown text is wrapped", () => {
    const spend = { usage: { ...ZERO_USAGE, inputTokens: 5 }, cost: usd(0.5) };
    const own = new Error("own");
    const outer = new Error("outer", { cause: own });

    expect(withPartialSpend(own, spend)).toBe(own);
    expect(partialSpendOfError(own)).toBe(spend);
    expect(partialSpendOfError(outer)).toBe(spend);
    const wrapped = withPartialSpend("a text", spend) as Error;
    expect(wrapped.message).toBe("a text");
    expect(wrapped.cause).toBe("a text");
    expect(partialSpendOfError(wrapped)).toBe(spend);
    expect(partialSpendOfError(new Error("none"))).toBeUndefined();
    expect(partialSpendOfError(null)).toBeUndefined();
    expect(partialSpendOfError({ cause: own })).toBeUndefined();
  });

  it("the fallback chain that was serving it is carried the same way, apart from the spend", () => {
    const trace = {
      server: { provider: "backup", model: "b/m", cost: undefined },
      earlier: [{ chars: 4 }],
    };
    const own = new Error("own");
    const outer = new Error("outer", { cause: own });

    expect(withFailoverTrace(own, trace)).toBe(own);
    expect(failoverTraceOf(outer)).toBe(trace);
    expect(partialSpendOfError(outer)).toBeUndefined();
    const wrapped = withFailoverTrace("a text", trace) as Error;
    expect([wrapped.message, wrapped.cause]).toEqual(["a text", "a text"]);
    expect(failoverTraceOf(wrapped)).toBe(trace);
    expect(failoverTraceOf(new Error("none"))).toBeUndefined();
    expect(failoverTraceOf(undefined)).toBeUndefined();
    expect(failoverTraceOf({ cause: own })).toBeUndefined();
  });
});

describe("#1356: the records of a call that failed mid-way", () => {
  // a token costs one dollar to read and two to write, so every amount below is exact
  const price = { inputPerMillion: usd(1_000_000), outputPerMillion: usd(2_000_000) };
  const settings = { model: "base/model", modelProvider: "acme", price };
  const failure = new Error("stream cut");

  it("counted from the chunks that came, a token being four characters, the prompt's the request's: priced as a completed call", () => {
    const records = partialUsageRecordsOf("agent:clerk", settings, failure, {
      requestChars: 5,
      answerChars: 9,
    });

    expect(records).toStrictEqual([
      {
        caller: "agent:clerk",
        model: "base/model",
        ...ZERO_USAGE,
        inputTokens: 2,
        outputTokens: 3,
        provider: "acme",
        costUsd: 8,
        costSource: CostSource.PriceTable,
      },
    ]);
    expect(
      partialUsageRecordOf("agent:clerk", settings, failure, { requestChars: 5, answerChars: 9 }),
    ).toStrictEqual(records[0]);
  });

  it("nothing came and nothing was reported: no record", () => {
    expect(
      partialUsageRecordsOf("c", settings, failure, { requestChars: 100, answerChars: 0 }),
    ).toStrictEqual([]);
    expect(
      partialUsageRecordOf("c", settings, failure, { requestChars: 100, answerChars: 0 }),
    ).toBeUndefined();
  });

  it("what the provider reported replaces the count, its cost first, its cache tokens kept", () => {
    const reported = withPartialSpend(new Error("cut"), {
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5 },
      cost: usd(0.5),
    });

    const [record] = partialUsageRecordsOf("c", settings, reported, {
      requestChars: 999,
      answerChars: 999,
    });

    expect(record).toStrictEqual({
      caller: "c",
      model: "base/model",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      provider: "acme",
      costUsd: 0.5,
      costSource: CostSource.Api,
    });
  });

  it("a report of nothing at a cost of nothing, or with no cost, is no record; a cost with no tokens is one", () => {
    const nothing = withPartialSpend(new Error("a"), { usage: ZERO_USAGE, cost: usd(0) });
    const noCost = withPartialSpend(new Error("b"), { usage: ZERO_USAGE });
    const onlyCost = withPartialSpend(new Error("c"), { usage: ZERO_USAGE, cost: usd(0.25) });
    const call = { requestChars: 4, answerChars: 4 };

    expect(partialUsageRecordsOf("c", settings, nothing, call)).toStrictEqual([]);
    expect(partialUsageRecordsOf("c", settings, noCost, call)).toStrictEqual([]);
    expect(partialUsageRecordsOf("c", settings, onlyCost, call)).toMatchObject([
      { costUsd: 0.25, costSource: CostSource.Api },
    ]);
  });

  it("a call that cannot be priced is its tokens unpriced, under its model and provider, never dropped; any other failure is not hidden", () => {
    const unpriceable = { model: "base/model", modelProvider: "acme" };
    const noProvider = { model: "base/model" };
    const free = { ...unpriceable, unpriced: true as const };
    const call = { requestChars: 4, answerChars: 8 };
    const broken = {
      get model(): string {
        throw new TypeError("no model");
      },
    };

    expect(partialUsageRecordsOf("c", unpriceable, failure, call)).toStrictEqual([
      {
        caller: "c",
        model: "base/model",
        ...ZERO_USAGE,
        inputTokens: 1,
        outputTokens: 2,
        provider: "acme",
        costUsd: 0,
        costSource: CostSource.Unpriced,
      },
    ]);
    expect(partialUsageRecordsOf("c", noProvider, failure, call)[0]?.provider).toBe(NO_PROVIDER);
    expect(partialUsageRecordsOf("c", free, failure, call)[0]).toMatchObject({
      costSource: CostSource.Unpriced,
    });
    expect(() => partialUsageRecordsOf("c", broken as never, failure, call)).toThrow(TypeError);
    expect(ConfigError.ModelCost).toBeDefined();
  });

  it("a fallback chain bills each provider's share under its own provider, model and price, the serving one the characters the others did not stream", () => {
    const backupCost = ModelCost.fromPrices({
      "backup/m": { inputPerMillion: usd(10), outputPerMillion: usd(20) },
    });
    const serving = { provider: "backup", model: "backup/m", cost: backupCost };
    const trace = {
      server: serving,
      earlier: [
        { chars: 8 }, // the primary's own share, by its chunks
        {
          chars: 4,
          reported: { usage: { ...ZERO_USAGE, inputTokens: 6, outputTokens: 7 }, cost: usd(0.125) },
        },
      ],
    };
    const error = withFailoverTrace(new Error("cut"), trace);

    const records = partialUsageRecordsOf("c", settings, error, {
      requestChars: 4,
      answerChars: 20,
    });

    expect(
      records.map((r) => [
        r.provider,
        r.model,
        r.inputTokens,
        r.outputTokens,
        r.costUsd,
        r.costSource,
      ]),
    ).toEqual([
      ["acme", "base/model", 1, 2, 5, CostSource.PriceTable],
      ["acme", "base/model", 6, 7, 0.125, CostSource.Api],
      ["backup", "backup/m", 1, 2, 0.00005, CostSource.PriceTable],
    ]);
  });

  it("a serving provider whose characters were all streamed by the earlier ones has none of its own", () => {
    const error = withFailoverTrace(new Error("cut"), {
      server: { provider: "backup", model: "backup/m", cost: undefined },
      earlier: [{ chars: 40 }],
    });

    const records = partialUsageRecordsOf("c", settings, error, {
      requestChars: 4,
      answerChars: 8,
    });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ provider: "acme", outputTokens: 10 });
  });

  it("the providers that failed before a fallback answered are billed from the mark it left, each under its own, those that spent nothing left out", () => {
    const backup = { provider: "backup", model: "backup/m", cost: undefined };
    const metadata = {
      usage: {
        [FALLBACK_MARK]: {
          model: "backup/m",
          provider: "backup",
          earlier: [{ chars: 8, server: backup }, { chars: 0 }],
        },
      },
    };

    const records = earlierUsageRecordsOf("c", settings, metadata, 4);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      provider: "backup",
      model: "backup/m",
      inputTokens: 1,
      outputTokens: 2,
    });
    expect(earlierUsageRecordsOf("c", settings, {}, 4)).toStrictEqual([]);
    expect(earlierUsageRecordsOf("c", settings, undefined, 4)).toStrictEqual([]);
  });
});

describe("#1356: what a stream heard", () => {
  it("the counter sums the characters of the tokens it is told, and is a handler of the call's callbacks that is awaited", () => {
    const counter = new ChunkCounter();

    counter.handleLLMNewToken("abc");
    counter.handleLLMNewToken("de");

    expect(counter.chars).toBe(5);
    expect(counter.name).toBe("ChunkCounter");
    expect(counter.awaitHandlers).toBe(true);
    expect(counter).toBeInstanceOf(BaseCallbackHandler);
  });

  it("is added to the call's callbacks, after them, whatever form they have: none, a list or a manager", () => {
    const counter = new ChunkCounter();
    const other = new ChunkCounter();
    const list = [other];
    const copy = vi.fn((handlers: unknown[]) => ["copied", ...handlers]);

    expect(withChunkCounter(undefined, counter)).toEqual([counter]);
    expect(withChunkCounter(list, counter)).toEqual([other, counter]);
    expect(list).toEqual([other]);
    expect(withChunkCounter({ copy } as never, counter)).toEqual(["copied", counter]);
    expect(copy).toHaveBeenCalledWith([counter]);
  });

  it("the characters a request sends: a text's own, any other content as its JSON", () => {
    expect(requestChars([])).toBe(0);
    expect(requestChars([{ content: "abcd" }, { content: "ef" }])).toBe(6);
    expect(requestChars([{ content: [{ type: "text", text: "hi" }] }, { content: "x" }])).toBe(
      JSON.stringify([{ type: "text", text: "hi" }]).length + 1,
    );
  });

  const depsOf = () => {
    const tally = vi.fn((records: readonly UsageRecord[], _path?: readonly string[]) =>
      records.map((record) => ({ ...record, tallied: true })),
    );
    return {
      tally,
      deps: {
        agent: {
          name: "clerk-agent",
          binding: {
            settings: {
              model: "base/model",
              modelProvider: "acme",
              price: { inputPerMillion: usd(1_000_000), outputPerMillion: usd(2_000_000) },
            },
          },
        },
        budgets: { tally },
      } as never,
    };
  };

  it("what a call that failed had spent is counted in the budgets at once on the path, under the agent; none is none", () => {
    const { deps, tally } = depsOf();
    const counter = new ChunkCounter();
    counter.handleLLMNewToken("abcdefghi");

    const spent = partialSpendOf(
      deps,
      ["flow", "clerk"],
      [{ content: "hello" }] as never,
      new Error("cut"),
      counter,
    );

    expect(tally).toHaveBeenCalledWith(
      [expect.objectContaining({ caller: "clerk-agent", inputTokens: 2, outputTokens: 3 })],
      ["flow", "clerk"],
    );
    expect(spent).toEqual([expect.objectContaining({ caller: "clerk-agent", tallied: true })]);
    const silent = partialSpendOf(
      deps,
      ["flow"],
      [{ content: "hello" }] as never,
      new Error("cut"),
      new ChunkCounter(),
    );
    expect(silent).toStrictEqual([]);
    expect(tally).toHaveBeenCalledOnce();
  });

  it("what the providers that failed before a fallback answered billed is read from the response's mark", () => {
    const { deps } = depsOf();
    const response = {
      response_metadata: {
        usage: {
          [FALLBACK_MARK]: { model: "backup/m", provider: "backup", earlier: [{ chars: 8 }] },
        },
      },
    };

    const earlier = earlierSpendOf(deps, [{ content: "abcd" }] as never, response);

    expect(earlier).toEqual([
      expect.objectContaining({
        caller: "clerk-agent",
        model: "base/model",
        inputTokens: 1,
        outputTokens: 2,
      }),
    ]);
    expect(earlierSpendOf(deps, [], { response_metadata: {} })).toStrictEqual([]);
  });
});

describe("#1356: a failed call's records, the cases that settle which are spend", () => {
  const price = { inputPerMillion: usd(1_000_000), outputPerMillion: usd(2_000_000) };
  const settings = { model: "base/model", modelProvider: "acme", price };
  const failed = (spend: object) => withPartialSpend(new Error("cut"), spend as never);
  const call = { requestChars: 0, answerChars: 0 };

  it.each([
    ["cache reads beside input tokens", { inputTokens: 1, cacheReadTokens: 1 }],
    ["cache writes beside cache reads", { cacheReadTokens: 1, cacheWriteTokens: 1 }],
    ["cache writes alone", { cacheWriteTokens: 2 }],
    ["cache reads alone", { cacheReadTokens: 2 }],
    ["output tokens alone", { outputTokens: 1 }],
  ])("a report of %s is spend: a record is made", (_why, tokens) => {
    const records = partialUsageRecordsOf(
      "c",
      settings,
      failed({ usage: { ...ZERO_USAGE, ...tokens } }),
      call,
    );

    expect(records).toHaveLength(1);
  });

  it("a fallback's share keeps the cache tokens it reported, and the cost it reported, under its own provider and model", () => {
    const backup = { provider: "backup", model: "backup/m", cost: undefined };
    const error = withFailoverTrace(new Error("cut"), {
      server: { provider: "serving", model: "serving/m", cost: undefined },
      earlier: [
        {
          server: backup,
          reported: {
            usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 3, cacheWriteTokens: 2 },
            cost: usd(0.5),
          },
          chars: 0,
        },
      ],
    });

    const [record] = partialUsageRecordsOf("c", settings, error, call);

    expect(record).toStrictEqual({
      caller: "c",
      model: "backup/m",
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 3,
      cacheWriteTokens: 2,
      provider: "backup",
      costUsd: 0.5,
      costSource: CostSource.Api,
    });
  });

  it("a fallback that can be priced neither by its report nor by a table is its tokens unpriced, under its own model and provider", () => {
    const error = withFailoverTrace(new Error("cut"), {
      server: { provider: "serving", model: "serving/m", cost: ModelCost.fromResponse() },
      earlier: [],
    });

    const [record] = partialUsageRecordsOf("c", settings, error, {
      requestChars: 4,
      answerChars: 8,
    });

    expect(record).toStrictEqual({
      caller: "c",
      model: "serving/m",
      ...ZERO_USAGE,
      inputTokens: 1,
      outputTokens: 2,
      provider: "serving",
      costUsd: 0,
      costSource: CostSource.Unpriced,
    });
  });

  it("a failure of the record's own that is no pricing failure is the call's, not an unpriced record", () => {
    let reads = 0;
    const flaky = {
      model: "base/model",
      get modelProvider(): string {
        reads += 1;
        if (reads === 1) throw new TypeError("the settings broke");
        return "acme";
      },
    };

    expect(() =>
      partialUsageRecordsOf("c", flaky as never, new Error("cut"), {
        requestChars: 4,
        answerChars: 8,
      }),
    ).toThrow("the settings broke");
  });

  it("a thrown null cannot carry a spend, so it is wrapped: the spend is kept all the same", () => {
    const spend = { usage: ZERO_USAGE };
    const trace = { server: { provider: "p", model: "m", cost: undefined }, earlier: [] };
    const record = billedDecisionRecord({ caller: "c", model: "m" }, {}, {});

    for (const wrapped of [
      withPartialSpend(null, spend) as Error,
      withFailoverTrace(null, trace) as Error,
      withDecisionSpend(null, record) as Error,
    ]) {
      expect(wrapped).toBeInstanceOf(Error);
      expect(wrapped.message).toBe("null");
      expect(wrapped.cause).toBeNull();
    }
  });
});
