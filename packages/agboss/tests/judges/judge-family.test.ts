/**
 * #396 PR 5 (S2 Q9): `[judge.same-model-family]` — a model judge whose model's vendor prefix is the
 * judged agent's warns (an error under `--strict`); another vendor, a code judge or a model id
 * without a vendor prefix does not.
 */
import { describe, expect, it } from "vitest";
import { checkWorkflow } from "../../src/flow/analyse/analyse.js";
import { modelFamilyOf, sameFamilyWarnings } from "../../src/flow/analyse/rules/judge-family.js";
import { Workflow } from "../../src/index.js";
import type { Class } from "../../src/components/injection.js";
import { onStart } from "../helpers/flow.js";
import {
  AliasJudge,
  AliasProvider,
  ClaudeJudge,
  FamilyReply,
  FamilyTaskStart,
  JudgeFamilyWorkflow,
  JevJudge,
  JudgelessAgent,
  MirrorJudge,
  MirrorProvider,
  PlainJudge,
  NoRetryAgent,
  OtherProvider,
  RetryAgent,
  ZeroRetryAgent,
} from "./fixtures/judge-family.workflow.js";

/** A workflow of one agent, to read what the rules say of it. */
function workflowOf(agent: Class) {
  @Workflow({
    name: "one-agent-workflow",
    version: "1.0.0",
    flow: [onStart(FamilyTaskStart).toAgent(agent).toFinish(FamilyReply)],
    defaults: { router: { model: "typesafe/jev-1.13" } },
  })
  class OneAgentWorkflow {}
  return OneAgentWorkflow;
}

describe("[judge.same-model-family]", () => {
  it("the family is the slug's vendor prefix; an id without one has none", () => {
    expect(modelFamilyOf("openai/gpt-6")).toBe("openai");
    expect(modelFamilyOf("moonshotai/kimi-k2.6")).toBe("moonshotai");
    expect(modelFamilyOf("/gpt-6")).toBeUndefined();
    expect(modelFamilyOf("unknown-model")).toBeUndefined();
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

  it.each([
    ["gpt-6", "openai"],
    ["o3-mini", "openai"],
    ["claude-sonnet-5", "anthropic"],
    ["gemini-3-pro", "google"],
    ["deepseek-v4", "deepseek"],
    ["qwen3-max", "qwen"],
    ["llama-4", "meta-llama"],
    ["mistral-large", "mistralai"],
    ["codestral-2", "mistralai"],
    ["grok-5", "x-ai"],
  ])("a slash-less %s is of the %s family", (model, family) => {
    expect(modelFamilyOf(model)).toBe(family);
  });

  it("a vendor prefix and a bare id of one vendor are one family", () => {
    expect(modelFamilyOf("anthropic/claude-sonnet-5")).toBe(modelFamilyOf("claude-sonnet-5"));
  });

  it("resolves the judge's role through its provider before it compares: fast is gpt-6-mini", () => {
    const warnings = sameFamilyWarnings(AliasJudge, [{ name: "w", model: "openai/gpt-6" }], "");

    expect(warnings.map(({ code }) => code)).toEqual(["judge.same-model-family"]);
    expect(warnings[0]?.message).toContain("alias-judge (gpt-6-mini)");
    expect(sameFamilyWarnings(AliasJudge, [{ name: "w", model: "claude-sonnet-5" }], "")).toEqual(
      [],
    );
  });

  it("resolves the agent's role through its own provider too", () => {
    const warnings = sameFamilyWarnings(
      ClaudeJudge,
      [{ name: "w", model: "fast", modelProvider: AliasProvider }],
      "",
    );
    expect(warnings).toEqual([]);
    expect(
      sameFamilyWarnings(
        JevJudge,
        [{ name: "w", model: "default", modelProvider: AliasProvider }],
        "",
      ),
    ).toEqual([]);
  });

  it("a model id of no known vendor is one family only on the same endpoint with the same model", () => {
    const judged = (modelProvider: Class) => [{ name: "w", model: undefined, modelProvider }];

    expect(sameFamilyWarnings(MirrorJudge, judged(OtherProvider), "")).toEqual([]);
    const [same] = sameFamilyWarnings(MirrorJudge, judged(MirrorProvider), "");
    expect(same?.code).toBe("judge.same-model-family");
    expect(same?.message).toContain("(shared-model) judges w, whose model shared-model");
  });

  it("a judge that names neither a model nor a provider is unknown before assembly", () => {
    expect(sameFamilyWarnings(PlainJudge, [{ name: "w", model: "gpt-6" }], "")).toEqual([]);
  });

  it("is an error under --strict", () => {
    const { errors, warnings } = checkWorkflow(JudgeFamilyWorkflow, { strict: true });

    expect(warnings).toEqual([]);
    expect(errors.map(({ code }) => code)).toEqual(["judge.same-model-family"]);
  });

  describe("[judge.zero-retries]", () => {
    const codes = (agent: Class) =>
      checkWorkflow(workflowOf(agent)).warnings.map(({ code }) => code);

    it("warns for an agent with judges and maxRetries unset or 0", () => {
      expect(codes(NoRetryAgent)).toEqual(["judge.zero-retries"]);
      expect(codes(ZeroRetryAgent)).toEqual(["judge.zero-retries"]);
    });

    it("says nothing for retries, or for an agent with no judges", () => {
      expect(codes(RetryAgent)).toEqual([]);
      expect(codes(JudgelessAgent)).toEqual([]);
    });

    it("is an error under --strict", () => {
      const { errors } = checkWorkflow(workflowOf(NoRetryAgent), { strict: true });
      expect(errors.map(({ code }) => code)).toEqual(["judge.zero-retries"]);
    });
  });
});
