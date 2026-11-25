import { usd } from "../../src/units/index.js";
/**
 * #1366: the cost a Decisions API answer states — the reported `usage.cost` is the call's, none reported is no cost,
 * and a cost below zero (which would take spend off the budgets' counters) makes the answer invalid.
 */
import { describe, expect, it } from "vitest";
import { Decision } from "../../src/llm/decisions.js";
import { readDecision } from "../../src/llm/decision-response.js";

const asked = { caller: "router:desk", model: "m", questions: { q: Decision.boolean("is it?") } };
const answers = { q: { type: "boolean", probability: 0.5 } };

describe("#1366: the cost of a decision", () => {
  it("is the reported cost, with the tokens, under the caller", () => {
    const read = readDecision(
      { answers, usage: { input_tokens: 10, output_tokens: 2, cost: 0.25 } },
      asked,
    );

    expect(read.usage).toMatchObject({
      caller: "router:desk",
      costUsd: usd(0.25),
      inputTokens: 10,
      outputTokens: 2,
    });
  });

  it("is none when none is reported", () => {
    expect(readDecision({ answers }, asked).usage.costUsd).toBe(0);
  });

  it("a negative cost is an invalid answer", () => {
    expect(() => readDecision({ answers, usage: { cost: -0.25 } }, asked)).toThrow("malformed");
  });
});
