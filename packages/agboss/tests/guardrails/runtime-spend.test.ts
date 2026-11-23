/**
 * #1366: what a model guardrail's decision cost — the call is in the spend the check hands on, whether the guardrail
 * decided or the call failed: a guardrail that fails closed names the spend of the calls so far on its error.
 */
import { AIMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { DecidedBy } from "../../src/flow/decorators/router.js";
import { GuardFailedError } from "../../src/errors.js";
import { runtimeGuardrailOf } from "../../src/guardrails/runtime.js";
import { GUARDRAIL_ANSWER_TOOL, GUARDRAIL_QUESTION } from "../../src/prompts/guardrail.js";
import type { UsageRecord } from "../../src/finops/usage.js";

function partsAnswering(args: Record<string, unknown>) {
  const reply = new AIMessage({
    content: "",
    tool_calls: [{ id: "c1", name: GUARDRAIL_ANSWER_TOOL, args }],
    response_metadata: { usage: { cost: 0.25 } },
  });
  const chat = { bindTools: () => ({ invoke: () => Promise.resolve(reply) }) };
  return {
    resolve: () => undefined,
    modelOf: () => ({ kind: "llm" as const, model: "m" }),
    deciderDeps: {
      gateway: { chatModel: () => chat, routeTo: () => Promise.reject(new Error("unused")) },
      chatDefaults: { temperature: 0 },
    },
  };
}

const guardrail = {
  type: Object,
  name: "legal",
  decidedBy: DecidedBy.Model,
  model: "m",
  prompt: "is it legal advice?",
  threshold: 0.8,
  refusal: "no",
};

const checked = { side: "output", element: "agent", text: "hello" } as never;

describe("#1366: the spend of a model guardrail", () => {
  it("a decision adds its call to the spend and says whether it blocks", async () => {
    const runtime = runtimeGuardrailOf(
      guardrail as never,
      partsAnswering({ [GUARDRAIL_QUESTION]: true }) as never,
    );
    const spent: UsageRecord[] = [];

    const decided = await runtime.decide(checked, spent);

    expect(spent.map((each) => each.costUsd)).toEqual([0.25]);
    expect(decided).toMatchObject({ isBlocked: true });
  });

  it("a call whose answer cannot be read fails closed, naming the spend so far on the error", async () => {
    const runtime = runtimeGuardrailOf(
      guardrail as never,
      partsAnswering({ [GUARDRAIL_QUESTION]: "maybe" }) as never,
    );
    const spent: UsageRecord[] = [];

    const error = await runtime.decide(checked, spent).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(GuardFailedError);
    expect((error as GuardFailedError).usage.map((each) => each.costUsd)).toEqual([0.25]);
  });
});
