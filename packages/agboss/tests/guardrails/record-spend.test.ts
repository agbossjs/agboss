/**
 * #1366: what an agent's step keeps of its answer's guardrails — the cost of a guardrail's model is in the usage
 * the step hands on, so the execution's record (`includeRecord: true`) states the spend of the whole run, the agent's
 * answer checks included.
 */
import { describe, expect } from "vitest";
import { decideWith, replyWith, routeTo, testWith } from "../../src/testing/index.js";
import { usd } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import {
  AdviceAgent,
  ClinicApplication,
  ClinicStart,
  LegalAdviceGuardrail,
  NoLegalAdviceGuardrail,
  TriageRouter,
} from "./guardrails.fixture.js";

const test = testWith(ClinicApplication);

describe("#1366: the record of a run with guardrails", () => {
  test("states the guardrails' spend with the agent's own", async ({ app, mockModel }) => {
    mockModel(TriageRouter).thenReturn(routeTo(AdviceAgent));
    mockModel(LegalAdviceGuardrail).thenReturn(decideWith({ blocks: 0.1 }, { cost: usd(0.125) }));
    mockModel(NoLegalAdviceGuardrail).thenReturn(decideWith({ blocks: 0.1 }, { cost: usd(0.25) }));
    mockModel(AdviceAgent).thenReturn(replyWith("Drink water.", { cost: usd(0.5) }));

    const result = await execute(
      app,
      ClinicStart,
      { text: "I have a headache." },
      { execution: { locale: "en" }, includeRecord: true },
    );

    expect(result.spend.byCategory.guardrails).toBeCloseTo(0.375, 9);
    expect(result.record?.spend.byCategory.guardrails).toBeCloseTo(0.375, 9);
    expect(result.record?.spend.totalUsd).toBeCloseTo(0.875, 9);
  });
});
