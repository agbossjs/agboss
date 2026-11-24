/**
 * #1150 AC6–AC8 — assembly checks a child's PII policies on every static way into it (`.toWorkflow`,
 * `.forEachItem`, `route`): an exclusion names an inherited policy — the application's, its
 * workflow's or an ancestor's —, a conflict between an ancestor's and the child's lists is
 * `[pii.conflicting-rules]` naming the way; `agboss describe` and the start log show each way's
 * effective sets and every exclusion.
 */
import { describe, expect, it } from "vitest";
import {
  Agent,
  PiiKind,
  PiiPolicy,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  secret,
  inline,
  Ttl,
} from "../../src/index.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../src/dto/index.js";
import { Application } from "../../src/application/application.js";
import { applicationOf } from "../../src/application/assemble.js";
import { logStart } from "../../src/application/start-log.js";
import { applicationContextOf } from "../../src/flow/context/application-context.js";
import { piiPolicyLines } from "../../src/describe/pii-policies.js";
import { EmptyEnvironment } from "../../src/environments/empty.js";
import { NO_ENVIRONMENT_VALUES } from "../../src/environments/resolve.js";
import { GraphRuleError } from "../../src/graph/rule-error.js";
import type { FrameworkLog } from "../../src/infrastructure/logger.js";
import { listOf } from "../../src/flow/dto-wrappers.js";
import { effectivePiiPolicies } from "../../src/pii/effective-policies.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { onStart, toWorkflow } from "../helpers/flow.js";
import { ChainApplication, ChildSecretPiiPolicy, RootSecretPiiPolicy } from "./chain.fixture.js";
import { ContactPiiPolicy, GovernmentPiiPolicy } from "./pii.fixture.js";

@PiiPolicy({
  name: "email-kind-chain-pii-policy",
  description: "Emails by kind",
  rules: [PiiKind.Email.mask()],
  secret: secret("PII_UNIT_KEY"),
})
class EmailKindPiiPolicy {}

describe("#1150 AC6: what a child inherits (supersedes #120 AC11)", () => {
  const way = { path: ["root-workflow"], policies: [GovernmentPiiPolicy] };

  it("AC6: on a way in, the child's elements and its logs get the ancestors' lists too", () => {
    const result = effectivePiiPolicies({
      application: [ContactPiiPolicy],
      workflow: [ChildSecretPiiPolicy],
      workflowName: "child-workflow",
      elements: [{ name: "c-agent" }],
      inherited: [way],
    });

    expect(result.violations).toEqual([]);
    const [chain] = result.chains;
    expect(chain?.observability).toEqual([
      ContactPiiPolicy,
      GovernmentPiiPolicy,
      ChildSecretPiiPolicy,
    ]);
    expect(chain?.byElement.get("c-agent")).toEqual(chain?.observability);
    // as a root of its own: its own and the application's
    expect(result.byElement.get("c-agent")).toEqual([ContactPiiPolicy, ChildSecretPiiPolicy]);
  });

  it("AC6: an element may exclude an ancestor's policy — at its model only", () => {
    const result = effectivePiiPolicies({
      application: [ContactPiiPolicy],
      workflow: [],
      workflowName: "child-workflow",
      elements: [{ name: "c-agent", excludePiiPolicies: [GovernmentPiiPolicy] }],
      inherited: [way],
    });

    expect(result.violations).toEqual([]);
    expect(result.chains[0]?.byElement.get("c-agent")).toEqual([ContactPiiPolicy]);
    expect(result.chains[0]?.observability).toContain(GovernmentPiiPolicy);
  });

  it("AC6: @Workflow({ excludePiiPolicies }) — every model of the workflow, never its logs", () => {
    const result = effectivePiiPolicies({
      application: [ContactPiiPolicy],
      workflow: [],
      workflowName: "child-workflow",
      elements: [{ name: "c-agent" }],
      workflowExcludes: [GovernmentPiiPolicy],
      inherited: [way],
    });

    expect(result.violations).toEqual([]);
    expect(result.chains[0]?.model).toEqual([ContactPiiPolicy]);
    expect(result.chains[0]?.byElement.get("c-agent")).toEqual([ContactPiiPolicy]);
    expect(result.chains[0]?.observability).toEqual([ContactPiiPolicy, GovernmentPiiPolicy]);
    expect(result.excludes.workflow).toEqual([GovernmentPiiPolicy]);
  });

  it("AC6: [pii.exclude-not-inherited] — a policy no way into it, its workflow nor its application lists", () => {
    const result = effectivePiiPolicies({
      application: [ContactPiiPolicy],
      workflow: [],
      workflowName: "child-workflow",
      elements: [{ name: "c-agent", excludePiiPolicies: [RootSecretPiiPolicy] }],
      workflowExcludes: [ChildSecretPiiPolicy],
      inherited: [way],
    });

    expect(result.violations.map((item) => item.message)).toEqual([
      "child-workflow: excludePiiPolicies lists ChildSecretPiiPolicy, which neither its application nor a workflow that launches it lists",
      "c-agent: excludePiiPolicies lists RootSecretPiiPolicy, which neither its application, its workflow nor a workflow that launches it lists",
    ]);
  });
});

@WorkflowStart({ name: "cc-child-workflow-start", description: "s", input: WorkflowStartTextDto })
class ConflictChildStart {}

@WorkflowFinish({
  name: "cc-child-workflow-finish",
  description: "f",
  output: WorkflowFinishTextDto,
})
class ConflictChildFinish {}

@Agent({ name: "cc-agent", description: "d", prompt: inline("p"), model: "test/cc" })
class ConflictAgent {}

/** Lists e-mails by kind; its parents list them as tokens. */
@Workflow({
  name: "cc-child-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(ConflictChildStart).toAgent(ConflictAgent).toFinish(ConflictChildFinish)],
  piiPolicies: [EmailKindPiiPolicy],
})
class ConflictChildWorkflow {}

@WorkflowStart({
  name: "cc-root-workflow-start",
  description: "s",
  input: listOf(WorkflowStartTextDto),
})
class ConflictRootStart {}

@WorkflowFinish({
  name: "cc-root-workflow-finish",
  description: "f",
  output: WorkflowFinishTextDto,
})
class ConflictRootFinish {}

@Agent({ name: "cc-summary-agent", description: "d", prompt: inline("p"), model: "test/cc" })
class ConflictSummaryAgent {}

/** Its child per item: the edge `.forEachItem` is a way in too. */
@Workflow({
  name: "cc-root-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(ConflictRootStart)
      .forEachItem(toWorkflow(ConflictChildWorkflow), { takeFirst: 2 })
      .join()
      .toAgent(ConflictSummaryAgent)
      .toFinish(ConflictRootFinish),
  ],
  piiPolicies: [ContactPiiPolicy],
})
class ConflictRootWorkflow {}

@Application({
  name: "cc-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ConflictRootWorkflow],
  budgets: TEST_BUDGETS,
})
class ConflictApplication {}

describe("#1150 AC7: assembly checks every way into a child", () => {
  it("AC7: an ancestor's and the child's rules conflict — [pii.conflicting-rules] naming the way", async () => {
    const failure = await applicationOf(ConflictApplication).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GraphRuleError);
    const messages = (failure as GraphRuleError).violations
      .filter((item) => item.code === "pii.conflicting-rules")
      .map((item) => item.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        "cc-child-workflow (under cc-root-workflow): email is tokenize() in contact-pii-policy but mask() in email-kind-chain-pii-policy",
      ]),
    );
  });

  it("AC7: the fixture's exclusions of an ancestor's policy assemble; its chains are known", async () => {
    const assembled = await applicationOf(ChainApplication);
    const peek = assembled.workflows.find((each) => each.config.name === "chain-peek-workflow");

    expect(peek?.pii?.chains.map((chain) => chain.path)).toEqual([
      ["chain-root-workflow"],
      ["chain-plain-root-workflow"],
    ]);
  });
});

describe("#1150 AC8: describe and the start log show the effective sets and every exclusion", () => {
  it("AC8: `pii chains` — each way's sets, an element's own, each exclusion", async () => {
    const assembled = await applicationOf(ChainApplication);
    const linesOf = (name: string): string[] => {
      const workflow = assembled.workflows.find((each) => each.config.name === name);
      if (workflow === undefined) throw new Error(`no ${name}`);
      return piiPolicyLines(workflow);
    };

    expect(linesOf("chain-peek-workflow")).toEqual(
      expect.arrayContaining([
        "pii chains",
        "  chain-peek-workflow under chain-root-workflow: logs and traces masked by contact-pii-policy, root-secret-pii-policy, child-secret-pii-policy; models by contact-pii-policy, root-secret-pii-policy, child-secret-pii-policy; chain-peek-agent by contact-pii-policy, child-secret-pii-policy (excluded: root-secret-pii-policy by chain-peek-agent)",
      ]),
    );
    expect(linesOf("chain-open-workflow")).toEqual(
      expect.arrayContaining([
        "  chain-open-workflow: logs and traces masked by contact-pii-policy, child-secret-pii-policy; models by contact-pii-policy, child-secret-pii-policy (excluded: root-secret-pii-policy by the workflow)",
        "  chain-open-workflow under chain-root-workflow: logs and traces masked by contact-pii-policy, root-secret-pii-policy, child-secret-pii-policy; models by contact-pii-policy, child-secret-pii-policy (excluded: root-secret-pii-policy by the workflow)",
      ]),
    );
    expect(linesOf("chain-root-workflow").join("\n")).not.toContain("pii chains");
  });

  it("AC8: the start log says the same, once per way", async () => {
    const assembled = await applicationOf(ChainApplication);
    const lines: { code: string; message: string }[] = [];
    const log: FrameworkLog = {
      info: (code, message) => lines.push({ code, message }),
      warn: (code, message) => lines.push({ code, message }),
      error: (code, message) => lines.push({ code, message }),
    };
    const application = applicationContextOf({
      name: "chain-application",
      version: "1.0.0",
      instanceId: "i",
      startedAt: new Date(0),
      environmentName: "test",
      environment: NO_ENVIRONMENT_VALUES,
    });

    logStart(log, application, assembled.workflows, []);

    const pii = lines
      .filter((line) => line.code === "app.pii-policies")
      .map((line) => line.message);
    expect(pii).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^chain-child-workflow under chain-root-workflow: logs and traces masked by contact-pii-policy, root-secret-pii-policy, child-secret-pii-policy/u,
        ),
        expect.stringMatching(
          /^chain-peek-workflow under chain-root-workflow: .*\(excluded: root-secret-pii-policy by chain-peek-agent\)$/u,
        ),
      ]),
    );
    expect(new Set(pii).size).toBe(pii.length);
    // a way that inherits nothing is the workflow's own sets: not repeated
    expect(pii.join("\n")).not.toContain("under chain-plain-root-workflow");
  });
});
