import { usd } from "../../src/units/index.js";
/**
 * #1366: what a judge's model calls cost — the usage of reading the call through the agent's policies, then the
 * call's own, are both added to the judge's spend, for a chat call and for a decision.
 */
import { AIMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { CostSource, ZERO_USAGE, type UsageRecord } from "../../src/finops/usage.js";
import { meteredModel } from "../../src/graph/agent-loop/judge-model.js";
import { ModelKind } from "../../src/llm/decision-errors.js";
import type { ModelReadingMask } from "../../src/pii/model-boundary.js";

const record = (costUsd: number, caller: string): UsageRecord => ({
  provider: "test-provider",
  ...ZERO_USAGE,
  caller,
  model: "m",
  costUsd: usd(costUsd),
  costSource: CostSource.Api,
});

const mask: ModelReadingMask = (texts) =>
  Promise.resolve({ texts, tokens: {}, usage: [record(0.125, "mask")] });

describe("#1366: the spend of a judge's model", () => {
  it("a chat call adds its reading's usage, then its own", async () => {
    const spent: UsageRecord[] = [];
    const binding = {
      kind: ModelKind.Chat,
      model: "m",
      chat: {
        settings: { model: "m" },
        model: {
          invoke: () =>
            Promise.resolve(
              new AIMessage({ content: "ok", response_metadata: { usage: { cost: 0.5 } } }),
            ),
        },
      },
    };

    await meteredModel({ name: "grounded", binding: binding as never }, spent, mask).invoke("q");

    expect(spent.map((each) => [each.caller, each.costUsd])).toEqual([
      ["mask", 0.125],
      ["judge:grounded", 0.5],
    ]);
  });

  it("a decision adds its reading's usage, then its own", async () => {
    const spent: UsageRecord[] = [];
    const binding = {
      kind: ModelKind.Decisions,
      model: "m",
      decide: () => Promise.resolve({ answers: {}, usage: record(0.5, "decide") }),
    };

    await meteredModel({ name: "grounded", binding: binding as never }, spent, mask).decide({
      state: "s",
      questions: {},
    });

    expect(spent.map((each) => [each.caller, each.costUsd])).toEqual([
      ["mask", 0.125],
      ["decide", 0.5],
    ]);
  });
});
