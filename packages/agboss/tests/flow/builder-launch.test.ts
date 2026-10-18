import { describe, expect, it } from "vitest";
import { NodeKind, StepKind, type FlowPath } from "../../src/flow/ast.js";
import { FlowSyntaxError, toAction, toFinish } from "../../src/flow/builder.js";
import { declarationOf } from "../../src/flow/decorators/declaration.js";
import { listOf, optional } from "../../src/flow/dto-wrappers.js";
import { flowLines } from "../../src/flow/print.js";
import { LimitExceededError } from "../../src/graph/limits.js";
import { LoyaltyOfferDto, OrderStatusDto } from "./fixtures/data-dtos.js";
import {
  CompanyCheckDto,
  PaymentDto,
  RefundPolicyDto,
  ScreeningFailedDto,
} from "./fixtures/launch-dtos.js";
import {
  ChargePaymentAction,
  CheckoutWorkflow,
  CompanyAuditAgent,
  CriticAgent,
  HelpDeskRouter,
  HelpDeskWorkflow,
  HelpDeskWorkflowStart,
  NotifyOperatorAction,
  PlanResearcherAgent,
  PlannerAgent,
  ResearchWorkflow,
  ScreeningFailedWorkflowFinish,
  ScreeningWorkflow,
  SendReceiptAction,
} from "./fixtures/launch.fixture.js";
import { agent, action, router, start } from "./fixtures/paths.js";
import { PlanDto, ResearchDto } from "./fixtures/review-dtos.js";
import { WorkflowStartTextDto } from "./fixtures/dtos.js";

/** #273 PR 1 — launches and joins in the AST: what the builder writes, and what it refuses. */

const flowOf = (workflow: abstract new () => unknown): readonly FlowPath[] => {
  const declaration = declarationOf(workflow);
  if (declaration?.kind !== NodeKind.Workflow) throw new TypeError("not a workflow");
  return declaration.options.flow;
};

const stepsOf = (workflow: abstract new () => unknown) => flowOf(workflow)[0]?.steps ?? [];

describe("#273: a launch and its join in the AST", () => {
  it("different agents: the targets as listed, repeats kept, maxConcurrency, not per item", () => {
    const launch = stepsOf(ResearchWorkflow).find((step) => step.kind === StepKind.Launch);
    expect(launch).toEqual({
      kind: StepKind.Launch,
      targetKind: NodeKind.Agent,
      targets: [PlanResearcherAgent, CriticAgent, CriticAgent],
      perItem: false,
      maxConcurrency: 3,
    });
  });

  it("the join keeps its values in order and its .onJoinError side paths", () => {
    const join = stepsOf(ScreeningWorkflow).find((step) => step.kind === StepKind.Join);
    expect(join).toEqual({
      kind: StepKind.Join,
      returns: [{ shape: listOf(CompanyCheckDto) }],
      onJoinError: [
        {
          error: LimitExceededError,
          path: {
            steps: toAction(NotifyOperatorAction)
              .returns(ScreeningFailedDto)
              .toFinish(ScreeningFailedWorkflowFinish).steps,
          },
        },
      ],
    });
  });

  it("one target right after .returns(listOf(XDto)) runs per item, with maxItems", () => {
    const launch = stepsOf(ScreeningWorkflow).find((step) => step.kind === StepKind.Launch);
    expect(launch).toMatchObject({ targets: [CompanyAuditAgent], perItem: true, maxItems: 50 });
  });

  it("one target after a single value is a plain launch, not per item", () => {
    const path = agent(PlannerAgent).returns(PlanDto).toParallelAgents(CriticAgent).join();
    expect(path.steps[1]).toMatchObject({ kind: StepKind.Launch, perItem: false });
  });

  it("parallel actions without output: the join has no values", () => {
    const steps = stepsOf(CheckoutWorkflow);
    expect(steps.map((step) => step.kind)).toEqual([
      StepKind.Returns,
      StepKind.To,
      StepKind.Returns,
      StepKind.Launch,
      StepKind.Join,
      StepKind.To,
    ]);
    expect(steps[3]).toMatchObject({ targetKind: NodeKind.Action, targets: expect.any(Array) });
    expect(steps[4]).toEqual({ kind: StepKind.Join, returns: [], onJoinError: [] });
  });

  it("a router's launch follows .toRouter(R); its join's optional values are written as named", () => {
    const join = stepsOf(HelpDeskWorkflow).find((step) => step.kind === StepKind.Join);
    expect(join).toMatchObject({
      returns: [
        { shape: OrderStatusDto },
        { shape: optional(RefundPolicyDto) },
        { shape: optional(LoyaltyOfferDto) },
      ],
    });
  });
});

describe("#273: the order around a launch holds for untyped code too (FlowSyntaxError)", () => {
  const launched = () => agent(PlannerAgent).returns(PlanDto).toParallelAgents(PlanResearcherAgent);

  it("a launch is followed by .join()", () => {
    expect(() => launched().toAgent(CriticAgent)).toThrow(FlowSyntaxError);
    expect(() => launched().returns(ResearchDto)).toThrow("a parallel launch is followed by .join()");
  });

  it(".join() follows a launch, .onJoinError stands before the join's .returns", () => {
    expect(() => agent(PlannerAgent).join()).toThrow(".join() follows a parallel launch");
    const valued = launched().join().returns(ResearchDto);
    expect(() => valued.onJoinError(LimitExceededError, toFinish(ScreeningFailedWorkflowFinish))).toThrow(
      ".onJoinError(E, …) stands right after .join(), before its .returns(…)",
    );
  });

  it(".onError after a join, and a second launch right after a join, are refused", () => {
    expect(() => launched().join().onError(LimitExceededError, toFinish(ScreeningFailedWorkflowFinish))).toThrow(
      "use .onJoinError(E, …) right after .join()",
    );
    expect(() => launched().join().returns(ResearchDto).toParallelAgents(CriticAgent)).toThrow(
      "after .join() the path goes on with",
    );
  });

  it("targets are classes, the options last, the limits positive integers", () => {
    const planned = () => agent(PlannerAgent).returns(PlanDto);
    expect(() => planned().toParallelAgents()).toThrow("takes one or more component classes");
    expect(() => planned().toParallelAgents("critic")).toThrow("takes one or more component classes");
    expect(() => planned().toParallelAgents(CriticAgent, { maxConcurrency: 0 })).toThrow(
      "toParallelAgents(…, { maxConcurrency }) takes a positive integer",
    );
    expect(() => planned().toParallelAgents(CriticAgent, { maxItems: 1.5 })).toThrow(
      "toParallelAgents(…, { maxItems }) takes a positive integer",
    );
    expect(() => planned().toParallelAgents(CriticAgent, null)).toThrow(
      "takes component classes, then { maxConcurrency, maxItems }",
    );
  });

  it("a router launches agents only", () => {
    expect(() => router(HelpDeskRouter).toParallelActions(SendReceiptAction)).toThrow(
      "a router launches agents only",
    );
    expect(() =>
      start(HelpDeskWorkflowStart)
        .returns(WorkflowStartTextDto)
        .toRouter(HelpDeskRouter)
        .toParallelActions(SendReceiptAction),
    ).toThrow("a router launches agents only");
    expect(action(ChargePaymentAction).returns(PaymentDto).toParallelActions(SendReceiptAction).steps).toHaveLength(2);
  });
});

describe("#273: describe prints launches and joins in the grammar", () => {
  it("one call per line: the launch with its options, the join, its side path and values", () => {
    expect(flowLines(flowOf(ScreeningWorkflow))).toEqual([
      "start(ScreeningWorkflowStart)",
      "  .returns(WorkflowStartTextDto)",
      "  .toAgent(ScreeningAgent)",
      "  .returns(listOf(CompanyDto))",
      "  .toParallelAgents(CompanyAuditAgent, { maxConcurrency: 3, maxItems: 50 })",
      "  .join()",
      "  .onJoinError(LimitExceededError, toAction(NotifyOperatorAction)",
      "    .returns(ScreeningFailedDto)",
      "    .toFinish(ScreeningFailedWorkflowFinish))",
      "  .returns(listOf(CompanyCheckDto))",
      "  .toAgent(RankerAgent)",
      "  .returns(RankingDto)",
      "  .toFinish(RankingWorkflowFinish)",
    ]);
  });

  it("a router's launch and parallel actions", () => {
    expect(flowLines(flowOf(HelpDeskWorkflow))).toContain(
      "  .toParallelAgents(OrderLookupAgent, RefundPolicyAgent, LoyaltyOfferAgent)",
    );
    expect(flowLines(flowOf(CheckoutWorkflow))).toContain(
      "  .toParallelActions(SendReceiptAction, UpdateCrmAction, ReserveGoodsAction, { maxConcurrency: 3 })",
    );
  });
});
