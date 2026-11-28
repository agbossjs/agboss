import { AIMessage } from "@langchain/core/messages";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { describe, expect, it, vi } from "vitest";
import {
  chargedCall,
  frameOrCollected,
  reportedCall,
  reportToFrame,
} from "../../src/finops/charged-call.js";
import { CostSource } from "../../src/finops/cost-source.js";
import type { UsageRecord } from "../../src/finops/usage.js";
import { runInFrame } from "../../src/flow/context/frame.js";
import { resolveSettings } from "../../src/llm/registry.js";
import { ModelCost } from "../../src/models/index.js";
import { markedFallbackMessage } from "../../src/models/fallback.js";
import { withFailoverTrace, withPartialSpend } from "../../src/models/transport/stream-partial.js";
import { createLlmRouter } from "../../src/routers/index.js";
import { usd } from "../../src/units/index.js";
import { testConfig } from "../helpers.js";
import { testFrame } from "../helpers/frame.js";
import { request } from "../routers/fixtures.js";
import { NO_PROVIDER } from "../../src/finops/usage.js";

/**
 * #1399: a model call of a component that is not the agent loop (a judge, a router, a reranker, a
 * compaction, a file reader, an interpreter) is accounted for what it spent when it fails mid-way, and
 * for what a provider that failed before a fallback answered billed.
 */

const settings = {
  ...resolveSettings({ model: "test/router" }, testConfig.defaults.models),
  price: { inputPerMillion: usd(1), outputPerMillion: usd(1) },
};
const usage = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 };
const caller = "router:main";

/** What a streamed call heard before it died: each handler of the call's callbacks gets the text. */
async function streamed(callbacks: unknown, text: string): Promise<void> {
  const handlers = Array.isArray(callbacks) ? callbacks : [];
  for (const handler of handlers) await handler.handleLLMNewToken?.(text);
}

describe("#1399: the spend of a failed call of any component", () => {
  it("counted from the chunks that came, once, and the failure stays the call's own", async () => {
    const sunk: UsageRecord[] = [];
    const failure = new Error("stream cut");

    const run = chargedCall(
      { caller, settings, sent: "four", sink: (records) => sunk.push(...records) },
      async (callbacks) => {
        await streamed(callbacks, "abcdefgh");
        throw failure;
      },
    );

    await expect(run).rejects.toBe(failure);
    expect(sunk).toEqual([
      expect.objectContaining({
        caller,
        inputTokens: 1,
        outputTokens: 2,
        costSource: CostSource.PriceTable,
      }),
    ]);
  });

  it("the provider's report replaces the count: never both", async () => {
    const sunk: UsageRecord[] = [];

    await chargedCall(
      { caller, settings, sent: "four", sink: (records) => sunk.push(...records) },
      async (callbacks) => {
        await streamed(callbacks, "abcdefgh");
        throw withPartialSpend(new Error("cut"), { usage });
      },
    ).catch(() => undefined);

    expect(sunk).toHaveLength(1);
    expect(sunk[0]).toMatchObject({ inputTokens: 100, outputTokens: 50 });
  });

  it("a failure before any chunk and any report spends nothing: no record", async () => {
    const sunk: UsageRecord[] = [];

    await chargedCall(
      { caller, settings, sent: "four", sink: (records) => sunk.push(...records) },
      () => Promise.reject(new Error("refused")),
    ).catch(() => undefined);

    expect(sunk).toEqual([]);
  });

  it("a failed fallback is recorded under the provider that served it, the primary's share apart", async () => {
    const sunk: UsageRecord[] = [];
    const backup = {
      provider: "backup-provider",
      model: "backup/m",
      cost: ModelCost.fromPrices({
        "backup/m": { inputPerMillion: usd(10), outputPerMillion: usd(20) },
      }),
    };

    await chargedCall(
      { caller, settings, sent: "four", sink: (records) => sunk.push(...records) },
      async (callbacks) => {
        await streamed(callbacks, "abcdefgh"); // the primary's, before it died
        await streamed(callbacks, "ijkl"); // the fallback's
        throw withFailoverTrace(new Error("cut"), { server: backup, earlier: [{ chars: 8 }] });
      },
    ).catch(() => undefined);

    expect(sunk.map((record) => [record.model, record.provider, record.outputTokens])).toEqual([
      ["test/router", NO_PROVIDER, 2],
      ["backup/m", "backup-provider", 1],
    ]);
  });

  it("an answer a fallback gave after the primary billed its chunks carries that share", async () => {
    const sunk: UsageRecord[] = [];
    const backup = { provider: "backup-provider", model: "backup/m", cost: undefined };
    const answer = markedFallbackMessage(new AIMessage({ content: "ok" }), backup, [{ chars: 8 }]);

    const given = await chargedCall(
      { caller, settings, sent: "four", sink: (records) => sunk.push(...records) },
      () => Promise.resolve(answer),
    );

    expect(given).toBe(answer);
    expect(sunk).toEqual([expect.objectContaining({ model: "test/router", outputTokens: 2 })]);
  });
});

describe("#1399: an LLM router that fails mid-way", () => {
  it("reports what it spent to its step, beside the outcome's own record", async () => {
    const model = new FakeListChatModel({ responses: ["x"] });
    model.invoke = async (_input, options) => {
      await streamed(options?.callbacks, "abcdefgh");
      throw new Error("the provider died");
    };
    const reported: UsageRecord[] = [];
    const frame = testFrame();

    const outcome = await runInFrame(
      { ...frame, services: { reportUsage: (record) => reported.push(record) } },
      () => createLlmRouter({ name: "main", model, settings }).route(request),
    );

    expect(outcome.kind).toBe("failed");
    expect(reported).toEqual([expect.objectContaining({ caller, outputTokens: 2 })]);
  });

  it("outside a step nothing is reported and nothing breaks", () => {
    expect(() => {
      reportToFrame([]);
    }).not.toThrow();
  });
});

describe("#1356: where the spend of a call that is no agent's goes", () => {
  const spent = (costUsd: number, name = "router:main"): UsageRecord => ({
    provider: "test-provider",
    model: "m",
    caller: name,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: usd(costUsd),
    costSource: CostSource.Api,
  });
  const inStepOf = (
    reportUsage: ((record: UsageRecord) => void) | undefined,
    work: () => Promise<unknown>,
  ) => runInFrame({ ...testFrame(), services: { reportUsage } }, work);

  it("reportToFrame hands every record, in order, to the step that is running; none to report to is no failure", async () => {
    const reportUsage = vi.fn();

    await inStepOf(reportUsage, () => {
      reportToFrame([spent(0.5), spent(0.25)]);
      return Promise.resolve();
    });
    expect(reportUsage.mock.calls).toEqual([[spent(0.5)], [spent(0.25)]]);

    expect(() => {
      reportToFrame([spent(1)]);
    }).not.toThrow();
    await expect(
      inStepOf(undefined, () => {
        reportToFrame([spent(1)]);
        return Promise.resolve();
      }),
    ).resolves.toBeUndefined();
  });

  it("frameOrCollected: in a step that takes reports the spend goes to it; anywhere else it is collected for the caller's result", async () => {
    const reportUsage = vi.fn();
    const inStep = frameOrCollected();
    const outside = frameOrCollected();
    const unreported = frameOrCollected();

    await inStepOf(reportUsage, () => {
      inStep.sink([spent(0.5)]);
      return Promise.resolve();
    });
    outside.sink([spent(0.25), spent(0.125)]);
    await inStepOf(undefined, () => {
      unreported.sink([spent(1)]);
      return Promise.resolve();
    });

    expect(reportUsage).toHaveBeenCalledExactlyOnceWith(spent(0.5));
    expect(inStep.collected).toEqual([]);
    expect(outside.collected).toEqual([spent(0.25), spent(0.125)]);
    expect(unreported.collected).toEqual([spent(1)]);
  });

  it("a call of a component with no sink of its own bills what it spent to the step it runs in", async () => {
    const reportUsage = vi.fn();

    await inStepOf(reportUsage, () =>
      reportedCall(caller, settings, "four", async (callbacks) => {
        await streamed(callbacks, "abcdefgh");
        throw new Error("cut");
      }).catch(() => undefined),
    );

    expect(reportUsage).toHaveBeenCalledOnce();
    expect(reportUsage.mock.calls[0]?.[0]).toMatchObject({
      caller,
      inputTokens: 1,
      outputTokens: 2,
    });
  });

  it("the prompt of a failed call is counted from what it sent: a text's own length, messages' JSON", async () => {
    const sunk: UsageRecord[] = [];
    const messages = [{ role: "user", content: "x".repeat(10) }]; // {"role":"user","content":"xxxxxxxxxx"} is 38 characters
    const fail = async (callbacks: unknown) => {
      await streamed(callbacks, "abcd");
      throw new Error("cut");
    };

    await chargedCall(
      { caller, settings, sent: "x".repeat(12), sink: (r) => sunk.push(...r) },
      fail,
    ).catch(() => undefined);
    await chargedCall(
      { caller, settings, sent: messages, sink: (r) => sunk.push(...r) },
      fail,
    ).catch(() => undefined);

    expect(sunk.map((record) => record.inputTokens)).toEqual([3, 10]);
  });

  it("an answer whose metadata is none, null or no record has no earlier share to bill", async () => {
    const sunk: UsageRecord[] = [];
    const spec = {
      caller,
      settings,
      sent: "four",
      sink: (records: readonly UsageRecord[]) => sunk.push(...records),
    };
    for (const response_metadata of [undefined, null, "text", 5, ["x"]])
      await chargedCall(spec, () => Promise.resolve({ response_metadata }));

    expect(sunk).toEqual([]);
  });

  it("an answer a fallback gave after a primary that spent nothing bills nothing; a failure that spent nothing bills nothing", async () => {
    const sunk: UsageRecord[] = [];
    const spec = {
      caller,
      settings,
      sent: "four",
      sink: (records: readonly UsageRecord[]) => sunk.push(...records),
    };
    const backup = { provider: "backup-provider", model: "backup/m", cost: undefined };
    const answer = markedFallbackMessage(new AIMessage({ content: "ok" }), backup, []);

    await chargedCall(spec, () => Promise.resolve(answer));
    await chargedCall(spec, () => Promise.reject(new Error("refused"))).catch(() => undefined);

    expect(sunk).toEqual([]);
  });

  it("the sink is asked only when there is something to take: a call with nothing earlier and a failure with nothing spent never ask", async () => {
    const sink = vi.fn();
    const spec = { caller, settings, sent: "four", sink };
    const backup = { provider: "backup-provider", model: "backup/m", cost: undefined };

    await chargedCall(spec, () =>
      Promise.resolve(markedFallbackMessage(new AIMessage({ content: "ok" }), backup, [])),
    );
    await chargedCall(spec, () => Promise.reject(new Error("refused"))).catch(() => undefined);
    await chargedCall(spec, () => Promise.resolve(new AIMessage({ content: "ok" })));

    expect(sink).not.toHaveBeenCalled();
  });
});
