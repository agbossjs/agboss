/** #262 PR 3 (S89): `testGuardrail` — a guardrail's hooks on their own, in a step's frame. */
import { describe, expect, it } from "vitest";
import { testGuardrail } from "../../../src/testing/index.js";
import { RefundLimitGuardrail } from "../fixtures/units.js";

const refund = (amount: number) => ({
  agent: "refund-agent",
  call: { name: "refund", args: { amount } },
});

describe("testGuardrail", () => {
  it("beforeToolCall lets a small refund through with corrected arguments", async () => {
    const guard = testGuardrail(RefundLimitGuardrail);

    const { output, spend } = await guard.beforeToolCall(refund(40));

    expect(output).toEqual({ overrideArguments: { note: "test:refund-limit-guardrail" } });
    expect(spend.totalUsd).toBe(0);
  });

  it("what a hook throws rejects as it was thrown: a block", async () => {
    const guard = testGuardrail(RefundLimitGuardrail);

    await expect(guard.beforeToolCall(refund(500))).rejects.toThrow("500 is over the limit");
  });

  it("a hook the class does not have is a setup error", async () => {
    const guard = testGuardrail(RefundLimitGuardrail);

    await expect(guard.beforeAgentAnswer({ agent: "refund-agent" })).rejects.toThrow(
      "it has no beforeAgentAnswer()",
    );
  });
});
