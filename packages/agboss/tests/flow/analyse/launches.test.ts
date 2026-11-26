import { ComponentKind } from "../../../src/flow/runtime/records.js";
import { LimitError } from "../../../src/core/error-families/limit-errors.js";
import { describe, expect, it } from "vitest";
import { checkWorkflow } from "../../../src/flow/analyse/analyse.js";
import { worstCaseLine } from "../../../src/flow/analyse/worst-case.js";
import { Agent } from "../../../src/flow/decorators/agent.js";
import { Workflow, type WorkflowOptions } from "../../../src/flow/decorators/workflow.js";
import { listOf, oneOf, optional } from "../../../src/flow/dto-wrappers.js";
import { workflowOf } from "../../../src/components/assemble.js";
import { declarationOf } from "../../../src/flow/decorators/declaration.js";
import { BrokenScreeningWorkflow } from "../fixtures/broken-launch.fixture.js";
import {
  CompanyDto,
  CustomerReplyDto,
  LoyaltyOfferDto,
  OrderStatusDto,
} from "../fixtures/data-dtos.js";
import { WorkflowStartTextDto } from "../fixtures/dtos.js";
import { ArticleDraftDto, RefundPolicyDto } from "../fixtures/launch-dtos.js";
import {
  AnswerAgent,
  ArticleDraftWorkflowFinish,
  ArticleWriterAgent,
  ChargePaymentAction,
  CheckoutWorkflow,
  CheckoutWorkflowStart,
  CompanyAuditAgent,
  CriticAgent,
  HelpDeskRouter,
  HelpDeskWorkflow,
  HelpDeskWorkflowFinish,
  HelpDeskWorkflowStart,
  LoyaltyOfferAgent,
  NotifyOperatorAction,
  OffersWorkflow,
  OrderLookupAgent,
  PaymentWorkflowFinish,
  PlannerAgent,
  PlanResearcherAgent,
  RankerAgent,
  RankingWorkflowFinish,
  RefundPolicyAgent,
  ResearchWorkflow,
  ResearchWorkflowStart,
  ReserveGoodsAction,
  ScreeningAgent,
  ScreeningFailedWorkflowFinish,
  ScreeningWorkflow,
  ScreeningWorkflowStart,
  SendReceiptAction,
  UpdateCrmAction,
} from "../fixtures/launch.fixture.js";
import { StepError } from "../../../src/core/error-families/step-errors.js";
import { onAgent, onStart, skip, toAction, toAgent, toRouter } from "../fixtures/paths.js";
import { CritiqueDto, PlanDto, ResearchDto } from "../fixtures/review-dtos.js";
import { inline, Ttl } from "../../../src/index.js";

/** #273 PR 1 — launches in the analyser: scopes, joins, policies, widths, steps. */

type Flow = WorkflowOptions["flow"];

let count = 0;
/** A workflow of one flow, named uniquely. */
function workflowWith(
  flow: Flow,
  options: Partial<WorkflowOptions> = {},
): abstract new () => unknown {
  count += 1;
  @Workflow({
    name: `launch-case-${String(count)}-workflow`,
    version: "1.0.0",
    historyTtl: Ttl.Forever,
    flow,
    ...options,
  })
  class LaunchCaseWorkflow {}
  return LaunchCaseWorkflow;
}

const errorsOf = (flow: Flow, options: Partial<WorkflowOptions> = {}) =>
  checkWorkflow(workflowWith(flow, options)).errors.map(({ code, message }) => ({ code, message }));

const codesOf = (flow: Flow, options: Partial<WorkflowOptions> = {}): readonly string[] =>
  errorsOf(flow, options).map((found) => found.code);

const planned = () => onStart(ResearchWorkflowStart).toAgent(PlannerAgent);
const screened = () => onStart(ScreeningWorkflowStart).toAgent(ScreeningAgent);
const ranked = (launched: ReturnType<typeof screened>) =>
  launched.join().toAgent(RankerAgent).toFinish(RankingWorkflowFinish);

@Agent({
  name: "critique-reader-agent",
  description: "Reads one critique",
  prompt: inline("Read the critique."),
  model: "moonshotai/kimi-k2.6",
  input: { critique: CritiqueDto },
  output: ArticleDraftDto,
})
class CritiqueReaderAgent {}

@Agent({
  name: "sibling-reader-agent",
  description: "Reads a sibling's value",
  prompt: inline("Read the research."),
  model: "moonshotai/kimi-k2.6",
  input: { research: ResearchDto },
  output: CritiqueDto,
})
class SiblingReaderAgent {}

@Agent({
  name: "refund-reader-agent",
  description: "Needs the refund policy",
  prompt: inline("Answer."),
  model: "moonshotai/kimi-k2.6",
  input: { order: OrderStatusDto, refund: RefundPolicyDto, loyalty: optional(LoyaltyOfferDto) },
  output: CustomerReplyDto,
})
class RefundReaderAgent {}

@Agent({
  name: "lists-agent",
  description: "Gives a list",
  prompt: inline("List."),
  model: "moonshotai/kimi-k2.6",
  input: { plan: PlanDto },
  output: listOf(CritiqueDto),
})
class ListsAgent {}

@Agent({
  name: "either-agent",
  description: "Gives one of two",
  prompt: inline("Choose."),
  model: "moonshotai/kimi-k2.6",
  input: { plan: PlanDto },
  output: oneOf(CritiqueDto, ResearchDto),
})
class EitherAgent {}

@Agent({
  name: "critiques-agent",
  description: "Reads every critique",
  prompt: inline("Read the critiques."),
  model: "moonshotai/kimi-k2.6",
  input: { critiques: listOf(CritiqueDto) },
  output: ArticleDraftDto,
})
class CritiquesAgent {}

const researchFlow = (
  join: (path: ReturnType<typeof planned>) => ReturnType<typeof planned>,
): Flow => [
  join(
    planned()
      .inParallel([toAgent(PlanResearcherAgent), toAgent(CriticAgent), toAgent(CriticAgent)])
      .join(),
  ),
];

describe("#273: the issue's examples pass", () => {
  it.each([
    ["different agents", ResearchWorkflow],
    ["one agent per item", ScreeningWorkflow],
    ["parallel actions", CheckoutWorkflow],
    ["a model router's launch", HelpDeskWorkflow],
    ["a code router's launch", OffersWorkflow],
  ])("%s", (_, workflow) => {
    expect(checkWorkflow(workflow).errors).toEqual([]);
  });
});

describe("#273 AC5: the join's values — checked against the branches, read by type", () => {
  it("several of one class → listOf: a single field reading it is [input.several-on-path]", () => {
    const flow = researchFlow((joined) =>
      joined.toAgent(CritiqueReaderAgent).toFinish(ArticleDraftWorkflowFinish),
    );
    expect(codesOf(flow)).toContain("input.several-on-path");
    expect(
      errorsOf(flow).find((found) => found.code === "input.several-on-path")?.message,
    ).toContain(
      "critique-reader-agent.critique (CritiqueDto): critic-agent brings several CritiqueDto values on the path",
    );
  });

  it("a join value nobody reads is [flow.unused-output], named after the join", () => {
    const flow: Flow = [
      planned()
        .inParallel([toAgent(CriticAgent), toAgent(CriticAgent)])
        .join()
        .toAgent(CritiquesAgent)
        .toFinish(ArticleDraftWorkflowFinish),
      planned()
        .inParallel([toAgent(PlanResearcherAgent)])
        .join()
        .toFinish(ArticleDraftWorkflowFinish),
    ];
    expect(errorsOf(flow).map((found) => found.message)).toContainEqual(
      expect.stringContaining(
        "the join of planner-agent → inParallel(plan-researcher-agent) returns ResearchDto that no node reads",
      ),
    );
  });

  it("a branch whose output cannot be joined: a list of lists, a lone oneOf", () => {
    const lists = errorsOf([
      planned()
        .inParallel([toAgent(ListsAgent), toAgent(ListsAgent)])
        .join()
        .toFinish(ArticleDraftWorkflowFinish),
    ]);
    expect(lists.map((found) => found.message)).toContainEqual(
      expect.stringContaining(
        "lists-agent gives listOf(CritiqueDto), several times — a join holds no list of lists",
      ),
    );
    const either = errorsOf([
      planned()
        .inParallel([toAgent(EitherAgent)])
        .join()
        .toFinish(ArticleDraftWorkflowFinish),
    ]);
    expect(either.map((found) => found.message)).toContainEqual(
      expect.stringContaining(
        "either-agent gives oneOf(CritiqueDto, ResearchDto) — a join takes one class per branch",
      ),
    );
  });

  it("a branch sees the scope at the launch, never a sibling's value", () => {
    const flow = [
      planned()
        .inParallel([toAgent(PlanResearcherAgent), toAgent(SiblingReaderAgent)])
        .join()
        .toAgent(CritiqueReaderAgent)
        .toFinish(ArticleDraftWorkflowFinish),
    ];
    expect(errorsOf(flow)).toContainEqual({
      code: "input.missing-on-path",
      message: `launch-case-${String(count)}-workflow: sibling-reader-agent.research (ResearchDto) is not produced on the path research-workflow-start → planner-agent → sibling-reader-agent`,
    });
  });
});

describe("#273 AC8: a value that may be missing is optional(…) for every consumer", () => {
  const helpDesk = () =>
    onStart(HelpDeskWorkflowStart)
      .inParallel([
        toAgent(OrderLookupAgent),
        toAgent(LoyaltyOfferAgent).onError(StepError, skip()),
        toRouter(HelpDeskRouter).chooseMany([toAgent(RefundPolicyAgent)]),
      ])
      .join();

  it("a required consumer field for a value a router may leave out is [input.missing-on-path]", () => {
    const flow = [helpDesk().toAgent(RefundReaderAgent).toFinish(HelpDeskWorkflowFinish)];
    expect(errorsOf(flow).map((found) => found.message)).toContainEqual(
      expect.stringContaining(
        "refund-reader-agent.refund (RefundPolicyDto) is not produced on the path",
      ),
    );
  });
});

describe("#273 AC10: a per-item target reads its item", () => {
  it("AC2: a per-item target reads its item: [launch.item-not-read]", () => {
    expect(checkWorkflow(BrokenScreeningWorkflow).errors.map((found) => found.code)).toEqual([
      "launch.item-not-read",
    ]);
  });
});

describe("#273 AC4: a launch is joined, and its branches end at the join", () => {
  it("a launch without .join() fails (untyped code)", () => {
    expect(codesOf([planned().inParallel([toAgent(CriticAgent)])])).toContain(
      "launch.join-required",
    );
  });

  it("a branch continued elsewhere is [launch.branch-continued]", () => {
    const flow = [
      planned()
        .inParallel([toAgent(CriticAgent), toAgent(CriticAgent)])
        .join()
        .toAgent(CritiquesAgent)
        .toFinish(ArticleDraftWorkflowFinish),
      onAgent(CriticAgent).toFinish(ArticleDraftWorkflowFinish),
    ];
    expect(errorsOf(flow)).toContainEqual(
      expect.objectContaining({
        code: "launch.branch-continued",
        message: expect.stringContaining(
          "critic-agent is a branch of planner-agent → inParallel(critic-agent, critic-agent)",
        ),
      }),
    );
  });

  it("two .onError handlers of one class on a join", () => {
    const side = () => toAction(NotifyOperatorAction).toFinish(ScreeningFailedWorkflowFinish);
    const flow = [
      screened()
        .forEachItem(toAgent(CompanyAuditAgent), { takeFirst: 3 })
        .join()
        .onError(LimitError, side())
        .onError(LimitError, side())
        .toAgent(RankerAgent)
        .toFinish(RankingWorkflowFinish),
    ];
    expect(errorsOf(flow)).toContainEqual({
      code: "flow.duplicate-error-handler",
      message: `launch-case-${String(count)}-workflow: the join of screening-agent → forEachItem(company-audit-agent) has 2 handlers for LimitError — one .onError(LimitError, …) per class on a join`,
    });
  });
});

const routerFlow = (
  launcher: abstract new () => unknown,
  targets: readonly (abstract new () => unknown)[],
): Flow => [
  onStart(HelpDeskWorkflowStart)
    .inParallel([toRouter(launcher).chooseMany(targets.map((target) => toAgent(target)))])
    .join()
    .toAgent(RefundReaderAgent)
    .toFinish(HelpDeskWorkflowFinish),
];

describe("#273 AC6: a router's launch lists its routes", () => {
  it("the launch lists the router's routes: [router.routes-mismatch]", () => {
    const flow = routerFlow(HelpDeskRouter, [OrderLookupAgent]);
    expect(errorsOf(flow)).toContainEqual({
      code: "router.routes-mismatch",
      message: `launch-case-${String(count)}-workflow: help-desk-router: the flow's routes and @Router({ routes }) differ — not in @Router({ routes }): order-lookup-agent; missing in .chooseMany([…]): refund-policy-agent`,
    });
  });
});

describe("#273: steps and the worst case count the launch", () => {
  it("maxSteps counts the copies that always run", () => {
    expect(codesOf(flowOf(ResearchWorkflow), { executionLimits: { maxSteps: 4 } })).toContain(
      "limits.max-steps-too-low",
    );
    expect(codesOf(flowOf(ResearchWorkflow), { executionLimits: { maxSteps: 5 } })).toEqual([]);
  });

  it("OnDemand and Skip branches and per-item runs count 0 for the fewest steps", () => {
    expect(codesOf(flowOf(HelpDeskWorkflow), { executionLimits: { maxSteps: 3 } })).toEqual([]);
    expect(codesOf(flowOf(ScreeningWorkflow), { executionLimits: { maxSteps: 2 } })).toEqual([]);
  });

  it("the worst case of one call: a per-item launch at maxItems, capped by maxSteps", () => {
    const [wide] =
      checkWorkflow(workflowWith(flowOf(ScreeningWorkflow), { executionLimits: { maxSteps: 100 } }))
        .analysis?.worstCases ?? [];
    expect(wide).toMatchObject({
      start: "screening-workflow-start",
      executions: 1,
      concurrentExecutions: 1,
      steps: 52,
      isStepsCapped: false,
      treeSteps: 52,
      depth: 0,
      children: [],
      parts: [
        "maxItems 50 on screening-agent → forEachItem(company-audit-agent)",
        "maxConcurrency 3 on screening-agent → forEachItem(company-audit-agent)",
      ],
    });
    const [capped] = checkWorkflow(ScreeningWorkflow).analysis?.worstCases ?? [];
    expect(capped === undefined ? "" : worstCaseLine(capped)).toBe(
      "Worst case of one screening-workflow-start call: 1 workflow execution, 1 at the same time, 9 steps",
    );
  });
});

describe("#273 PR 2: a launch assembles", () => {
  it("a workflow with launches assembles into one join node per launch", async () => {
    const assembled = await workflowOf(ResearchWorkflow);

    expect(assembled.graph.launches.map((launch) => launch.joinNodeId)).toEqual([
      "planner-agent.join",
    ]);
    expect([...assembled.graph.branchNodes].sort()).toEqual([
      "critic-agent",
      "plan-researcher-agent",
    ]);
  });
});

function flowOf(workflow: abstract new () => unknown): Flow {
  const declaration = declarationOf(workflow);
  if (declaration?.kind !== ComponentKind.Workflow) throw new TypeError("not a workflow");
  return declaration.options.flow;
}
