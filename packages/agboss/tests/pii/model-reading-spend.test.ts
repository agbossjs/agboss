import { usd } from "../../src/units/index.js";
/**
 * #1366: what a model's PII reading cost — a judge's texts and a model arbiter's question each go through the
 * agent's policies, and the paid detections are in the usage the judge or the arbiter hands back.
 */
import { AIMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { createArbiterModel } from "../../src/flow/runtime/launch/arbiter-model.js";
import { CostSource, ZERO_USAGE, type UsageRecord } from "../../src/finops/usage.js";
import { JudgeReading } from "../../src/graph/agent-loop/judge-reading.js";
import type { ModelReadingMask } from "../../src/pii/model-boundary.js";
import { ARBITER_ANSWER_TOOL, ARBITER_QUESTION } from "../../src/prompts/arbiter.js";

const record = (costUsd: number, caller: string): UsageRecord => ({
  ...ZERO_USAGE,
  caller,
  model: "m",
  costUsd: usd(costUsd),
  costSource: CostSource.Api,
});

/** A reading whose every text costs a record named after it. */
const costing: ModelReadingMask = (texts) =>
  Promise.resolve({
    texts,
    tokens: {},
    usage: texts.map((text) => record(0.125, `detect:${text.slice(0, 12)}`)),
  });

describe("#1366: the usage of a model's reading", () => {
  it("a judge's reading keeps the usage of each text it sent", async () => {
    const reading = new JudgeReading(costing);

    await reading.text("first");
    await reading.input(["second", "third"]);

    expect(reading.usage.map((each) => each.caller)).toEqual([
      "detect:first",
      "detect:second",
      "detect:third",
    ]);
  });

  it("a model arbiter's verdict carries its reading's usage before its own call's", async () => {
    const reply = new AIMessage({
      content: "",
      tool_calls: [{ id: "c1", name: ARBITER_ANSWER_TOOL, args: { [ARBITER_QUESTION]: true } }],
      response_metadata: { usage: { cost: 0.25 } },
    });
    const chat = { bindTools: () => ({ invoke: () => Promise.resolve(reply) }) };
    const gateway = { chatModel: () => chat, routeTo: () => Promise.reject(new Error("unused")) };
    const arbiter = createArbiterModel(
      "desk-arbiter",
      { kind: "llm", model: "m" },
      { gateway: gateway as never, chatDefaults: { temperature: 0 } },
    );

    const verdict = await arbiter.judge(
      { target: "desk", answer: "ok", criterion: "is it ok", instructions: "judge" },
      costing,
    );

    expect(verdict.kind).toBe("judged");
    expect(verdict.usage.map((each) => each.costUsd)).toEqual([0.125, 0.125, 0.125, 0.25]);
  });
});
