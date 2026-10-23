/**
 * #396 PR 5 (S2 Q9): `[judge.same-model-family]` — a model judge whose model's vendor prefix is the
 * judged agent's warns (an error under `--strict`); another vendor, a code judge or a model id
 * without a vendor prefix does not.
 */
import { describe, expect, it } from "vitest";
import { checkWorkflow } from "../../src/flow/analyse/analyse.js";
import { modelFamilyOf } from "../../src/flow/analyse/rules/judge-family.js";
import { JudgeFamilyWorkflow } from "./fixtures/judge-family.workflow.js";

describe("[judge.same-model-family]", () => {
  it("the family is the slug's vendor prefix; an id without one has none", () => {
    expect(modelFamilyOf("openai/gpt-6")).toBe("openai");
    expect(modelFamilyOf("moonshotai/kimi-k2.6")).toBe("moonshotai");
    expect(modelFamilyOf("gpt-6")).toBeUndefined();
    expect(modelFamilyOf("/gpt-6")).toBeUndefined();
  });

  it("warns for a judge of the agent's own family only — another vendor, a code judge or no prefix does not", () => {
    const { errors, warnings } = checkWorkflow(JudgeFamilyWorkflow);

    expect(errors).toEqual([]);
    expect(warnings).toEqual([
      {
        code: "judge.same-model-family",
        message:
          "judge-family-workflow: open-ai-judge (openai/gpt-6) judges writer-agent, whose model " +
          "openai/gpt-6-mini is of the same family (openai) — a judge grades its own family's " +
          "answers too kindly: give the judge a model of another vendor",
        nodes: ["open-ai-judge", "writer-agent"],
      },
    ]);
  });

  it("is an error under --strict", () => {
    const { errors, warnings } = checkWorkflow(JudgeFamilyWorkflow, { strict: true });

    expect(warnings).toEqual([]);
    expect(errors.map(({ code }) => code)).toEqual(["judge.same-model-family"]);
  });
});
