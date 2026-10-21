/**
 * #120 AC12 — `agboss describe` prints each guardrail's refusal: the decorator's text, or
 * `ClassName.refusal()` when the class computes it (PII policies' refusals: describe-report.test.ts).
 */
import { describe, expect, it } from "vitest";
import { applicationOf } from "../../src/application/assemble.js";
import { describeWorkflow } from "../../src/describe/describe-workflow.js";
import { ClinicApplication } from "./guardrails.fixture.js";

describe("#120 AC12: describe prints the guardrails' refusals", () => {
  it("a text refusal as written, a computed one as ClassName.refusal()", async () => {
    const [clinic] = (await applicationOf(ClinicApplication)).workflows;
    if (clinic === undefined) throw new Error("the clinic workflow is missing");

    const lines = describeWorkflow(clinic);

    expect(lines).toContainEqual(
      expect.stringMatching(
        /^ {2}legal-advice-guardrail — input ≥0\.8 · .* · refusal: LegalAdviceGuardrail\.refusal\(\) · on /,
      ),
    );
    expect(lines).toContainEqual(
      expect.stringContaining(
        `no-legal-advice-guardrail — output ≥0.8 · typesafe/jev-1.13 (own) · refusal: "I can't give legal advice. Please contact a lawyer."`,
      ),
    );
  });
});
