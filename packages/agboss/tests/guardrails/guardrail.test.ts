/**
 * #120 PR 2 — guardrails at assembly (AC1, AC2, AC4, AC11): names, models, refusals, levels. Every
 * rule broken fails the application's assembly, all at once.
 */
import { describe, expect, it } from "vitest";
import {
  Agent,
  DecidedBy,
  InputGuardrail,
  Injectable,
  OutputGuardrail,
  Router,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type GuardrailRefusal,
} from "../../src/index.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../src/dto/index.js";
import { Application } from "../../src/application/application.js";
import { applicationOf } from "../../src/application/assemble.js";
import type { Class } from "../../src/components/injection.js";
import { EmptyEnvironment } from "../../src/environments/empty.js";
import { GraphRuleError } from "../../src/graph/rule-error.js";
import { guardrailViolations } from "../../src/guardrails/checks.js";
import { effectiveGuardrails, GuardedElementKind } from "../../src/guardrails/levels.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { route, start } from "../helpers/flow.js";
import {
  LegalAdviceGuardrail,
  NoLegalAdviceGuardrail,
  PromptInjectionGuardrail,
} from "./guardrails.fixture.js";

const JEV = "typesafe/jev-1.13";

@InputGuardrail({
  name: "rude",
  description: "Misnamed",
  prompt: "Is it rude?",
  model: JEV,
  threshold: 0.5,
  refusal: "Be polite.",
})
class MisnamedGuardrail {}

@InputGuardrail({
  name: "twice-guardrail",
  description: "A text and a method",
  prompt: "Is it rude?",
  model: JEV,
  threshold: 0.5,
  refusal: "Be polite.",
})
class TwiceGuardrail implements GuardrailRefusal {
  refusal(): string {
    return "Be polite, twice.";
  }
}

// @ts-expect-error -- no refusal in the decorator, and the class has no refusal(): AC2's compiler error
@InputGuardrail({
  name: "silent-guardrail",
  description: "Neither",
  prompt: "Is it rude?",
  model: JEV,
  threshold: 0.5,
})
class SilentGuardrail {}

@OutputGuardrail({
  name: "vague-guardrail",
  description: "No question, a threshold out of range",
  threshold: 1.5,
  model: JEV,
  refusal: "No.",
})
class VagueGuardrail {}

@Injectable()
class NotAGuardrail {}

const codesOf = (classes: readonly Class[], defaultModel?: string): string[] =>
  guardrailViolations(classes, defaultModel).map((item) => item.code);

describe("#120 AC1, AC2: a guardrail's own rules", () => {
  it("[name.kind-suffix]: the name ends with -guardrail", () => {
    expect(codesOf([MisnamedGuardrail])).toEqual(["name.kind-suffix"]);
  });

  it("[guardrail.refusal-twice] and [guardrail.missing-refusal]: one refusal, never both, never neither", () => {
    expect(codesOf([TwiceGuardrail])).toEqual(["guardrail.refusal-twice"]);
    expect(codesOf([SilentGuardrail])).toEqual(["guardrail.missing-refusal"]);
    expect(codesOf([LegalAdviceGuardrail, NoLegalAdviceGuardrail])).toEqual([]);
  });

  it("[guardrail.no-prompt] and [guardrail.threshold-invalid]", () => {
    expect(codesOf([VagueGuardrail])).toEqual([
      "guardrail.no-prompt",
      "guardrail.threshold-invalid",
    ]);
  });

  it("[guardrail.no-model]: its own model or defaults.guardrail.model — no built-in", () => {
    expect(codesOf([PromptInjectionGuardrail])).toEqual(["guardrail.no-model"]);
    expect(codesOf([PromptInjectionGuardrail], JEV)).toEqual([]);
  });
});

describe("#120 AC4, AC11: levels", () => {
  const levels = {
    application: [PromptInjectionGuardrail],
    workflow: [NoLegalAdviceGuardrail],
    workflowName: "w-workflow",
  };

  it("lists add up: an agent gets the application's, the workflow's and its own, by side", () => {
    const result = effectiveGuardrails({
      ...levels,
      elements: [
        { name: "a-agent", kind: GuardedElementKind.Agent, guardrails: [LegalAdviceGuardrail] },
      ],
    });

    expect(result.violations).toEqual([]);
    expect(result.byElement.get("a-agent")).toEqual({
      input: [PromptInjectionGuardrail, LegalAdviceGuardrail],
      output: [NoLegalAdviceGuardrail],
    });
  });

  it("a model router takes the input guardrails only; a code router none", () => {
    const result = effectiveGuardrails({
      ...levels,
      elements: [
        { name: "m-router", kind: GuardedElementKind.ModelRouter },
        { name: "c-router", kind: GuardedElementKind.CodeRouter },
      ],
    });

    expect(result.byElement.get("m-router")).toEqual({
      input: [PromptInjectionGuardrail],
      output: [],
    });
    expect(result.byElement.get("c-router")).toEqual({ input: [], output: [] });
  });

  it("excludeGuardrails removes an inherited one for that element only", () => {
    const result = effectiveGuardrails({
      ...levels,
      elements: [
        {
          name: "a-agent",
          kind: GuardedElementKind.Agent,
          excludeGuardrails: [PromptInjectionGuardrail],
        },
        { name: "b-agent", kind: GuardedElementKind.Agent },
      ],
    });

    expect(result.byElement.get("a-agent")?.input).toEqual([]);
    expect(result.byElement.get("b-agent")?.input).toEqual([PromptInjectionGuardrail]);
  });

  it("[guardrail.exclude-not-inherited], [guardrail.not-a-guardrail]", () => {
    const result = effectiveGuardrails({
      ...levels,
      elements: [
        {
          name: "a-agent",
          kind: GuardedElementKind.Agent,
          guardrails: [NotAGuardrail],
          excludeGuardrails: [LegalAdviceGuardrail],
        },
      ],
    });

    expect(result.violations.map((item) => item.message)).toEqual([
      "a-agent: NotAGuardrail in guardrails is not an @InputGuardrail / @OutputGuardrail class",
      "a-agent: excludeGuardrails lists LegalAdviceGuardrail, which neither its application nor its workflow lists",
    ]);
  });

  it("[guardrail.output-on-router] and [guardrail.no-model-call]: a router's own list", () => {
    const result = effectiveGuardrails({
      application: [],
      workflow: [],
      workflowName: "w-workflow",
      elements: [
        {
          name: "m-router",
          kind: GuardedElementKind.ModelRouter,
          guardrails: [NoLegalAdviceGuardrail],
        },
        {
          name: "c-router",
          kind: GuardedElementKind.CodeRouter,
          guardrails: [PromptInjectionGuardrail],
        },
      ],
    });

    expect(result.violations.map((item) => item.code)).toEqual([
      "guardrail.output-on-router",
      "guardrail.no-model-call",
    ]);
  });

  it("#120 AC11: a child workflow gets its own workflow's lists over the application's", () => {
    const child = effectiveGuardrails({
      application: [PromptInjectionGuardrail],
      workflow: [LegalAdviceGuardrail],
      workflowName: "child-workflow",
      elements: [{ name: "c-agent", kind: GuardedElementKind.Agent }],
    });

    expect(child.byElement.get("c-agent")?.input).toEqual([
      PromptInjectionGuardrail,
      LegalAdviceGuardrail,
    ]);
    expect(child.byElement.get("c-agent")?.output).not.toContain(NoLegalAdviceGuardrail);
  });
});

@WorkflowStart({ name: "gr-workflow-start", description: "s", input: WorkflowStartTextDto })
class GuardedStart {}

@WorkflowFinish({ name: "gr-workflow-finish", description: "f", output: WorkflowFinishTextDto })
class GuardedFinish {}

@Agent({
  name: "gr-agent",
  description: "d",
  prompt: "p",
  model: "test/gr",
  guardrails: [MisnamedGuardrail],
  excludeGuardrails: [LegalAdviceGuardrail],
})
class GuardedAgent {}

@Router({
  name: "gr-router",
  description: "r",
  decidedBy: DecidedBy.Model,
  prompt: "Pick.",
  model: JEV,
  input: { message: WorkflowStartTextDto },
  guardrails: [NoLegalAdviceGuardrail],
  routes: [{ prompt: "Anything", target: GuardedAgent }],
})
class GuardedRouter {}

@Workflow({
  name: "gr-workflow",
  version: "1.0.0",
  flow: [
    start(GuardedStart)
      .returns(WorkflowStartTextDto)
      .toRouter(GuardedRouter)
      .chooseOne(route(GuardedAgent).toFinish(GuardedFinish)),
  ],
  guardrails: [PromptInjectionGuardrail],
})
class GuardedWorkflow {}

@Application({
  name: "gr-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [GuardedWorkflow],
  budgets: TEST_BUDGETS,
})
class GuardedApplication {}

describe("#120: the application's assembly reports every guardrail rule at once", () => {
  it("names, models, refusals and levels — one GraphRuleError", async () => {
    const error: unknown = await applicationOf(GuardedApplication).catch(
      (thrown: unknown) => thrown,
    );

    if (!(error instanceof GraphRuleError))
      throw new Error(`expected a GraphRuleError: ${String(error)}`);
    expect(error.violations.map((item) => item.code)).toEqual([
      "guardrail.exclude-not-inherited",
      "guardrail.output-on-router",
      "guardrail.no-model",
      "name.kind-suffix",
    ]);
  });
});
