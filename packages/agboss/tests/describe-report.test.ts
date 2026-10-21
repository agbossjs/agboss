/**
 * #268 PR 2 — `agboss describe` of an application (AC4): the tree of workflows with their starts
 * and children, the model providers and why, each channel role's question → answer with its
 * implementation, each PII policy's refusal (the text, or `ClassName.refusal()`); and the worst
 * case of one call of each start with how each number is made up (AC5), from the decorators only.
 */
import { describe, expect, it } from "vitest";
import { Application } from "../src/application/application.js";
import { applicationOf } from "../src/application/assemble.js";
import { describedChannelsOf, ChannelImplementationReason } from "../src/describe/channels.js";
import { describeApplication } from "../src/describe/describe-application.js";
import { describedLimitsOf, worstCaseLimitsOf } from "../src/describe/limits.js";
import { describedPiiPoliciesOf } from "../src/describe/pii-policies.js";
import { describedTreeOf } from "../src/describe/tree.js";
import { worstCaseReportLines, worstCaseRowsOf } from "../src/describe/worst-case-report.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../src/dto/index.js";
import { EmptyEnvironment } from "../src/environments/empty.js";
import { PauseAnswerer } from "../src/channels/channel-role.decorator.js";
import {
  Agent,
  PiiAction,
  PiiKind,
  PiiPolicy,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  pii,
} from "../src/index.js";
import { workflowOf } from "../src/testing/index.js";
import type { AssembledWorkflow } from "../src/workflow.js";
import type { Class } from "../src/components/injection.js";
import { TEST_BUDGETS } from "./flow/fixtures/budgets.js";
import { DeepResearchWorkflow } from "./flow/fixtures/recursion.fixture.js";
import { TreasuryApplication } from "./flow/fixtures/replies.fixture.js";
import { CardPiiPolicy } from "./pii/pii.fixture.js";
import {
  HelpDeskApplication,
  NoteCompaction,
  NotesDeskApplication,
} from "./compaction/compaction.fixture.js";
import { start } from "./helpers/flow.js";

/** A block rule with its own text, beside one whose class computes it. */
@PiiPolicy({
  name: "iban-pii-policy",
  description: "Refuses bank account numbers",
  rules: [
    pii(PiiKind.Iban, PiiAction.blockWithRefusal({ refusal: "Please do not send an IBAN." })),
    pii(PiiKind.Email, PiiAction.replaceWithKind()),
  ],
})
class IbanPiiPolicy {}

@Agent({ name: "clerk-agent", description: "Answers", prompt: "Answer.", model: "test/clerk" })
class ClerkAgent {}

@WorkflowStart({ name: "clerk-workflow-start", description: "Ask", input: WorkflowStartTextDto })
class ClerkWorkflowStart {}

@WorkflowFinish({
  name: "clerk-workflow-finish",
  description: "Answered",
  output: WorkflowFinishTextDto,
})
class ClerkWorkflowFinish {}

@Workflow({
  name: "clerk-workflow",
  version: "1.0.0",
  flow: [
    start(ClerkWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(ClerkAgent)
      .toFinish(ClerkWorkflowFinish),
  ],
  piiPolicies: [CardPiiPolicy],
})
class ClerkWorkflow {}

@Application({
  name: "clerk-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ClerkWorkflow],
  piiPolicies: [IbanPiiPolicy],
  budgets: TEST_BUDGETS,
})
class ClerkApplication {}

const treasury = await applicationOf(TreasuryApplication);
const clerk = await applicationOf(ClerkApplication);

const workflowNamed = (name: string): AssembledWorkflow => {
  const found = treasury.workflows.find((workflow) => workflow.config.name === name);
  if (found === undefined) throw new Error(`${name} is not assembled`);
  return found;
};

describe("#268 AC4: the tree — workflows, their starts and children", () => {
  it("each listed workflow with its starts; a child under its parent, one or one per item", () => {
    const tree = describedTreeOf(treasury);

    expect(tree.workflows.map((workflow) => workflow.name)).toEqual([
      "treasury-workflow",
      "treasury-desk-workflow",
      "treasury-batch-workflow",
    ]);
    expect(tree.workflows[2]).toEqual({
      name: "treasury-batch-workflow",
      version: "1.0.0",
      starts: ["treasury-batch-workflow-start (WorkflowStartTextDto)"],
      children: [
        {
          launch: {
            from: ["split-requests-action"],
            isPerItem: true,
            maxItems: 3,
            maxConcurrency: 2,
          },
          isRecursive: false,
          workflow: {
            name: "treasury-workflow",
            version: "1.0.0",
            starts: ["treasury-workflow-start (WorkflowStartTextDto)"],
            children: [],
          },
        },
      ],
    });
    const lines = describeApplication(treasury);
    const at = lines.indexOf("workflows");
    expect(lines.slice(at, at + 11)).toEqual([
      "workflows",
      "  treasury-workflow 1.0.0",
      "    start treasury-workflow-start (WorkflowStartTextDto)",
      "  treasury-desk-workflow 1.0.0",
      "    start treasury-desk-workflow-start (WorkflowStartTextDto)",
      "    child treasury-workflow 1.0.0 from treasury-desk-workflow-start",
      "      start treasury-workflow-start (WorkflowStartTextDto)",
      "  treasury-batch-workflow 1.0.0",
      "    start treasury-batch-workflow-start (WorkflowStartTextDto)",
      "    child treasury-workflow 1.0.0 per item from split-requests-action (maxItems 3, maxConcurrency 2)",
      "      start treasury-workflow-start (WorkflowStartTextDto)",
    ]);
  });

  it("ThisWorkflow is the workflow again, marked recursive with its maxDepth", async () => {
    const lines = describeApplication(await applicationOf(applicationWith(DeepResearchWorkflow)));

    expect(lines).toContain(
      "    child deep-research-workflow (ThisWorkflow, recursive, maxDepth 4) per item from split-topic-action (maxItems 5, maxConcurrency 3)",
    );
  });
});

describe("#268 AC4: model providers and channels with their implementations", () => {
  it("the built-in model providers when none is listed, and why", () => {
    const lines = describeApplication(treasury);
    const at = lines.indexOf("model providers");

    expect(lines.slice(at, at + 3)).toEqual([
      "model providers",
      expect.stringMatching(
        /^ {2}openrouter-model-provider → OpenRouterModelProvider \(built-in default: none listed\) · serves /,
      ),
      expect.stringMatching(
        /^ {2}decisions-model-provider → DecisionsModelProvider \(built-in default: none listed\) · serves /,
      ),
    ]);
  });

  it("each role: its question → answer, who answers, its interpreter, its implementation", () => {
    const channels = describedChannelsOf(treasury);

    expect(channels.find((channel) => channel.name === "payout-approval-channel")).toEqual({
      name: "payout-approval-channel",
      className: "PayoutApprovalChannel",
      isRole: true,
      question: "PayoutRequestDto",
      answer: "ToolCallApprovalDecisionDto",
      answeredBy: PauseAnswerer.Channel,
      replyInterpreter: "payout-reply-interpreter",
      implementation: "DeskPayoutApprovalChannel",
      reason: ChannelImplementationReason.Listed,
      tools: ["pay-out-tool (treasury-workflow)"],
    });
    expect(describeApplication(treasury)).toContain(
      "  expense-approval-channel (ExpenseApprovalChannel): ExpenseRequestDto → ToolCallApprovalDecisionDto · answered by the thread's owner · reply interpreter expense-reply-interpreter · ButtonExpenseApprovalChannel (listed in @Application providers) · tools book-expense-tool (treasury-workflow)",
    );
  });

  it("an application whose tools name no channel says so", () => {
    expect(describeApplication(clerk)).toContain("channels none");
  });
});

describe("#268 AC4: PII policies and their refusals", () => {
  it("a block rule's text, or ClassName.refusal() when the class computes it", () => {
    const [workflow] = clerk.workflows;
    if (workflow === undefined) throw new Error("clerk-workflow is assembled");
    const policies = describedPiiPoliciesOf(workflow);

    expect(policies.map((policy) => [policy.name, policy.rules])).toEqual([
      [
        "iban-pii-policy",
        [
          {
            target: "iban",
            action: "blockWithRefusal()",
            refusal: '"Please do not send an IBAN."',
          },
          { target: "email", action: "replaceWithKind()" },
        ],
      ],
      [
        "card-pii-policy",
        [
          {
            target: "card-number",
            action: "blockWithRefusal()",
            refusal: "CardPiiPolicy.refusal()",
          },
        ],
      ],
    ]);
    expect(describeApplication(clerk)).toContain(
      '  iban-pii-policy — iban: blockWithRefusal() · refusal: "Please do not send an IBAN.", email: replaceWithKind() · on clerk-agent · masks logs and traces',
    );
  });
});

/** An agent with a compaction of its own, in a workflow and an application that set none. */
@Agent({
  name: "own-note-agent",
  description: "Answers from its own note",
  prompt: "Answer.",
  model: "test/own-note",
  compaction: NoteCompaction,
})
class OwnNoteAgent {}

@WorkflowStart({ name: "own-note-workflow-start", description: "Ask", input: WorkflowStartTextDto })
class OwnNoteWorkflowStart {}

@WorkflowFinish({
  name: "own-note-workflow-finish",
  description: "Answered",
  output: WorkflowFinishTextDto,
})
class OwnNoteWorkflowFinish {}

@Workflow({
  name: "own-note-workflow",
  version: "1.0.0",
  flow: [
    start(OwnNoteWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(OwnNoteAgent)
      .toFinish(OwnNoteWorkflowFinish),
  ],
})
class OwnNoteWorkflow {}

describe("#268 AC4, #120 PR 3: each agent's compaction and window with where they came from", () => {
  const agentLine = (lines: readonly string[], agent: string): string | undefined =>
    lines.find((line) => line.startsWith(`  ${agent}  `));

  it("the agent's own, its workflow's, or its application's", async () => {
    const own = describeApplication(await applicationOf(applicationWith(OwnNoteWorkflow)));
    const workflow = describeApplication(await applicationOf(NotesDeskApplication));
    const application = describeApplication(await applicationOf(HelpDeskApplication));

    expect(agentLine(own, "own-note-agent")).toMatch(/ · compaction note-compaction \(own\)$/);
    expect(agentLine(workflow, "note-agent")).toMatch(
      / · compaction note-compaction \(notes-desk-workflow\)$/,
    );
    expect(agentLine(application, "answer-agent")).toMatch(
      / · compaction queue-compaction \(help-desk-application\)$/,
    );
    expect(application).toContainEqual(
      expect.stringMatching(/^ {4}defaults: .* · uncompactedTurns 3 \(help-desk-application\)$/),
    );
  });
});

describe("#268 AC5: the worst case of one call of each start, each number with how it is made up", () => {
  it("a per-item child launch: the executions, at once, the steps of the tree, the depth", () => {
    const batch = workflowNamed("treasury-batch-workflow");
    const limits = describedLimitsOf(batch);
    const [worst] = limits.worstCases;
    if (worst === undefined) throw new Error("the batch has a start");

    expect(worstCaseReportLines(worst, worstCaseLimitsOf(limits))).toEqual([
      "Worst case of one treasury-batch-workflow-start call",
      "  workflow executions     4  1 treasury-batch-workflow + 3 treasury-workflow (maxItems 3)",
      "  at the same time        3  1 treasury-batch-workflow + 2 treasury-workflow (maxConcurrency 2)",
      "  agent and router steps  4  1 in treasury-batch-workflow (longest path) + 3 × 1 in treasury-workflow (longest path)",
      "  nesting depth           2  treasury-batch-workflow → treasury-workflow",
    ]);
  });

  it("recursion: every level multiplied out, the depth bounded by maxDepth", async () => {
    const deep = await workflowOf(DeepResearchWorkflow);
    const limits = describedLimitsOf(deep);
    const [worst] = limits.worstCases;
    if (worst === undefined) throw new Error("the workflow has a start");
    const rows = worstCaseRowsOf(worst, worstCaseLimitsOf(limits));

    expect(rows.map((row) => [row.measure, row.total])).toEqual([
      ["workflow executions", 156],
      ["at the same time", 40],
      ["agent and router steps", 312],
      ["nesting depth", 4],
    ]);
    expect(rows[0]?.madeUp).toBe(
      "1 deep-research-workflow + 5 deep-research-workflow (maxItems 5) + 25 deep-research-workflow (maxItems 5 × maxItems 5) + 125 deep-research-workflow (maxItems 5 × maxItems 5 × maxItems 5)",
    );
    expect(rows[1]?.madeUp).toBe(
      "1 deep-research-workflow + 3 deep-research-workflow (maxConcurrency 3) + 9 deep-research-workflow (maxConcurrency 3 × maxConcurrency 3) + 27 deep-research-workflow (maxConcurrency 3 × maxConcurrency 3 × maxConcurrency 3) — at most 10 at work at once (maxConcurrentExecutions 10)",
    );
    expect(rows[3]?.madeUp).toBe(
      "deep-research-workflow → deep-research-workflow → deep-research-workflow → deep-research-workflow (maxDepth 4)",
    );
  });
});

/** An application of one workflow on the test budgets. */
function applicationWith(workflow: Class): Class {
  @Application({
    name: "one-workflow-application",
    version: "1.0.0",
    environment: EmptyEnvironment,
    workflows: [workflow],
    budgets: TEST_BUDGETS,
  })
  class OneWorkflowApplication {}
  return OneWorkflowApplication;
}
