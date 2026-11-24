/** #120 PR 2: `testUnit` — one guardrail on one text, its model scripted, in a step's frame. */
import { describe, expect, it } from "vitest";
import { GuardFailedError, GraphRuleError, InputGuardrail, inline } from "../../../src/index.js";
import { decideWith, failWith, ModelFailure, testUnit } from "../../../src/testing/index.js";
import { usd } from "../../../src/units/index.js";
import { LegalAdviceGuardrail } from "../fixtures/units.js";

describe("testUnit", () => {
  it("P(yes) at the threshold blocks: the class's refusal, computed in the step's frame", async () => {
    const check = testUnit(LegalAdviceGuardrail, {
      model: decideWith({ blocks: 0.8 }, { cost: usd(0.0001) }),
    });

    const { output, spend } = await check("Can I sue my landlord?");

    expect(output).toEqual({
      isBlocked: true,
      probability: 0.8,
      refusal: "No legal advice (test, legal-advice-guardrail).",
    });
    expect(spend.totalUsd).toBeCloseTo(0.0001, 9);
    expect(spend.trace.map((line) => line.caller)).toEqual(["guardrail:legal-advice-guardrail"]);
  });

  it("below the threshold it passes, with no refusal", async () => {
    const check = testUnit(LegalAdviceGuardrail, { model: decideWith({ blocks: 0.79 }) });

    const { output } = await check("Where is my order?");

    expect(output).toEqual({ isBlocked: false, probability: 0.79 });
  });

  it("unscripted, a guardrail passes: content checks are not what most tests are about", async () => {
    const check = testUnit(LegalAdviceGuardrail);

    expect((await check("anything")).output).toEqual({ isBlocked: false, probability: 0 });
  });

  it("a model that does not answer fails closed: GuardFailedError", async () => {
    const check = testUnit(LegalAdviceGuardrail, {
      model: failWith(ModelFailure.Timeout),
    });

    await expect(check("Can I sue?")).rejects.toBeInstanceOf(GuardFailedError);
  });

  it("its rules are checked first: a name that is not kebab-case is a GraphRuleError", () => {
    @InputGuardrail({
      name: "Legal_One",
      description: "Misnamed",
      prompt: inline("Legal?"),
      threshold: 0.5,
      refusal: "No.",
    })
    class Misnamed {}

    expect(() => testUnit(Misnamed)).toThrow(GraphRuleError);
    expect(() => testUnit(Misnamed)).toThrow("[name.not-kebab-case]");
  });
});
