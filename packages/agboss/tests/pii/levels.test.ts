/** #120 AC4, AC6, AC11: the lists add up, removal is explicit, conflicts and refusals are checked. */
import { describe, expect, it } from "vitest";
import {
  Agent,
  Injectable,
  PiiAction,
  PiiKind,
  PiiPolicy,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  pii,
  secret,
  type PiiRefusal,
} from "../../src/index.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../src/dto/index.js";
import { Application } from "../../src/application/application.js";
import { applicationOf } from "../../src/application/assemble.js";
import { EmptyEnvironment } from "../../src/environments/empty.js";
import { GraphRuleError } from "../../src/graph/rule-error.js";
import { effectivePiiPolicies } from "../../src/pii/effective-policies.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { start } from "../helpers/flow.js";
import { CardPiiPolicy, ContactPiiPolicy, GovernmentPiiPolicy } from "./pii.fixture.js";

const KEY = secret("PII_UNIT_KEY");

@PiiPolicy({
  name: "email-kind-pii-policy",
  description: "Emails by kind",
  rules: [pii(PiiKind.Email, PiiAction.replaceWithKind())],
  pseudonymKey: KEY,
})
class EmailKindPiiPolicy {}

@PiiPolicy({
  name: "no-refusal-pii-policy",
  description: "A block rule without a text",
  rules: [pii(PiiKind.Iban, PiiAction.blockWithRefusal())],
  pseudonymKey: KEY,
})
class NoRefusalPiiPolicy {}

@PiiPolicy({
  name: "unused-refusal-pii-policy",
  description: "A refusal method no rule uses",
  rules: [pii(PiiKind.Iban, PiiAction.blockWithRefusal({ refusal: "No IBANs." }))],
  pseudonymKey: KEY,
})
class UnusedRefusalPiiPolicy implements PiiRefusal {
  refusal(): string {
    return "unused";
  }
}

@PiiPolicy({
  name: "names-pii-policy",
  description: "Names without a model",
  rules: [
    pii(PiiKind.PersonName, PiiAction.replaceWithKind()),
    pii(PiiKind.Email, PiiAction.replaceWithKind()),
    pii(PiiKind.Email, PiiAction.replaceWithToken()),
  ],
  pseudonymKey: KEY,
})
class NamesPiiPolicy {}

@PiiPolicy({
  name: "badly-named",
  description: "Its name lacks the kind",
  rules: [pii(PiiKind.Jwt, PiiAction.replaceWithKind())],
  pseudonymKey: KEY,
})
class BadlyNamedPolicy {}

@Injectable()
class NotAPolicy {}

describe("#120 AC4: lists add up application → workflow → agent / router", () => {
  const levels = {
    application: [ContactPiiPolicy],
    workflow: [CardPiiPolicy],
    workflowName: "w-workflow",
  };

  it("an agent gets the application's, the workflow's and its own; logs get the first two", () => {
    const result = effectivePiiPolicies({
      ...levels,
      elements: [{ name: "a-agent", piiPolicies: [GovernmentPiiPolicy] }, { name: "b-router" }],
    });
    expect(result.violations).toEqual([]);
    expect(result.byElement.get("a-agent")).toEqual([
      ContactPiiPolicy,
      CardPiiPolicy,
      GovernmentPiiPolicy,
    ]);
    expect(result.byElement.get("b-router")).toEqual([ContactPiiPolicy, CardPiiPolicy]);
    expect(result.observability).toEqual([ContactPiiPolicy, CardPiiPolicy]);
  });

  it("exclude removes an inherited one for that element only — never for logs", () => {
    const result = effectivePiiPolicies({
      ...levels,
      elements: [{ name: "a-agent", excludePiiPolicies: [ContactPiiPolicy] }],
    });
    expect(result.byElement.get("a-agent")).toEqual([CardPiiPolicy]);
    expect(result.observability).toContain(ContactPiiPolicy);
  });

  it("excluding what is not inherited is an assembly error", () => {
    const result = effectivePiiPolicies({
      ...levels,
      elements: [{ name: "a-agent", excludePiiPolicies: [GovernmentPiiPolicy] }],
    });
    expect(result.violations.map((item) => item.code)).toEqual(["pii.exclude-not-inherited"]);
    expect(result.violations[0]?.message).toContain("GovernmentPiiPolicy");
  });

  it("#120 AC11: a child workflow gets its own workflow's lists over the application's", () => {
    const child = effectivePiiPolicies({
      application: [ContactPiiPolicy],
      workflow: [GovernmentPiiPolicy],
      workflowName: "child-workflow",
      elements: [{ name: "c-agent" }],
    });
    expect(child.byElement.get("c-agent")).toEqual([ContactPiiPolicy, GovernmentPiiPolicy]);
    expect(child.byElement.get("c-agent")).not.toContain(CardPiiPolicy);
  });
});

describe("#120 AC6: conflicting rules after adding up", () => {
  it("two policies with different actions for one kind name the kind, actions and policies", () => {
    const result = effectivePiiPolicies({
      application: [ContactPiiPolicy],
      workflow: [],
      workflowName: "w-workflow",
      elements: [{ name: "a-agent", piiPolicies: [EmailKindPiiPolicy] }],
    });
    const [conflict] = result.violations;
    expect(conflict?.code).toBe("pii.conflicting-rules");
    expect(conflict?.message).toBe(
      "a-agent: email is replaceWithToken() in contact-pii-policy but replaceWithKind() in email-kind-pii-policy",
    );
    expect(conflict?.nodes).toEqual(["a-agent", "contact-pii-policy", "email-kind-pii-policy"]);
  });

  it("an exclude resolves the conflict for that element", () => {
    const result = effectivePiiPolicies({
      application: [ContactPiiPolicy],
      workflow: [],
      workflowName: "w-workflow",
      elements: [
        {
          name: "a-agent",
          piiPolicies: [EmailKindPiiPolicy],
          excludePiiPolicies: [ContactPiiPolicy],
        },
      ],
    });
    expect(result.violations).toEqual([]);
  });
});

describe("#120: a policy's own rules", () => {
  const codesOf = (cls: new () => object): string[] =>
    effectivePiiPolicies({
      application: [cls],
      workflow: [],
      workflowName: "w-workflow",
      elements: [],
    }).violations.map((item) => item.code);

  it("[pii.missing-refusal]: blockWithRefusal() without text and without refusal(kind)", () => {
    expect(codesOf(NoRefusalPiiPolicy)).toEqual(["pii.missing-refusal"]);
  });

  it("[pii.unused-refusal]: refusal(kind) that no rule uses", () => {
    expect(codesOf(UnusedRefusalPiiPolicy)).toEqual(["pii.unused-refusal"]);
  });

  it("two actions for one kind, a model-only kind without detectWithModel", () => {
    expect(codesOf(NamesPiiPolicy)).toEqual(["pii.conflicting-rules", "pii.kind-needs-model"]);
  });

  it("[name.kind-suffix] and [pii.not-a-policy]", () => {
    expect(codesOf(BadlyNamedPolicy)).toEqual(["name.kind-suffix"]);
    expect(codesOf(NotAPolicy)).toEqual(["pii.not-a-policy"]);
  });
});

@WorkflowStart({ name: "lv-workflow-start", description: "s", input: WorkflowStartTextDto })
class LevelStart {}

@WorkflowFinish({ name: "lv-workflow-finish", description: "f", output: WorkflowFinishTextDto })
class LevelFinish {}

@Agent({
  name: "lv-agent",
  description: "d",
  prompt: "p",
  model: "test/lv",
  excludePiiPolicies: [GovernmentPiiPolicy],
})
class LevelAgent {}

@Workflow({
  name: "lv-workflow",
  version: "1.0.0",
  flow: [start(LevelStart).returns(WorkflowStartTextDto).toAgent(LevelAgent).toFinish(LevelFinish)],
  piiPolicies: [EmailKindPiiPolicy],
})
class LevelWorkflow {}

@Application({
  name: "lv-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [LevelWorkflow],
  piiPolicies: [ContactPiiPolicy],
  budgets: TEST_BUDGETS,
})
class LevelApplication {}

describe("#120: the rules fail the application's assembly, all at once", () => {
  it("a conflict and an exclude of what is not inherited", async () => {
    const failure = await applicationOf(LevelApplication).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GraphRuleError);
    const codes = (failure as GraphRuleError).violations.map((item) => item.code);
    expect(codes).toEqual(
      expect.arrayContaining(["pii.exclude-not-inherited", "pii.conflicting-rules"]),
    );
  });
});
