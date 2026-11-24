import { usd } from "../../src/units/index.js";
/**
 * #1366: what a decision-model reply interpreter cost — the masking of the reply and the decision call are both in
 * the reading's usage, whether the model answered yes / no or gave no answer, so the ledger holds each paid call.
 */
import { describe, expect, it } from "vitest";
import { readByDecision, type ReplyDecisionSite } from "../../src/channels/reply-decision.js";
import { CostSource, ZERO_USAGE, type UsageRecord } from "../../src/finops/usage.js";
import type { DecisionOutcome } from "../../src/llm/decision-response.js";

const record = (costUsd: number, caller: string): UsageRecord => ({
  ...ZERO_USAGE,
  caller,
  model: "m",
  costUsd: usd(costUsd),
  costSource: CostSource.Api,
});

const policies = {
  isEmpty: false,
  mask: (text: string) =>
    Promise.resolve({ masked: { text, blocked: [], tokens: {} }, usage: [record(0.125, "mask")] }),
  refusalError: () => Promise.resolve(undefined),
} as never;

const siteAnswering = (answers: DecisionOutcome["answers"]): ReplyDecisionSite => ({
  gateway: {
    decide: () => Promise.resolve({ answers, usage: record(0.25, "decide") }),
  } as never,
  model: "m",
  caller: "reply-interpreter:desk",
  pii: { policies, known: {} },
});

const interpreter = { instructions: "approve when it says yes" };
const input = { ask: { question: "Refund?" }, reply: "yes please" };

describe("#1366: the usage of a decision interpreter's reading", () => {
  it("an answer carries the masking and the decision, the masking first", async () => {
    const read = await readByDecision(
      interpreter as never,
      input,
      siteAnswering({ approved: { type: "boolean", probability: 0.9 } }),
    );

    expect(read).toMatchObject({ kind: "answered", answer: { approved: true } });
    expect(read.usage.map((each) => each.caller)).toEqual(["mask", "decide"]);
  });

  it("a model that gave no yes / no answer is declined with the same usage", async () => {
    const read = await readByDecision(interpreter as never, input, siteAnswering({}));

    expect(read.kind).toBe("declined");
    expect(read.usage.map((each) => each.caller)).toEqual(["mask", "decide"]);
  });
});
