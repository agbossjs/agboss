import { describe, expect, it } from "vitest";
import { NodeKind, StepKind, type FlowPath } from "../../src/flow/ast.js";
import { FlowSyntaxError, toAction } from "../../src/flow/builder.js";
import { declarationOf } from "../../src/flow/decorators/declaration.js";
import { listOf, optional } from "../../src/flow/dto-wrappers.js";
import { flowLines } from "../../src/flow/print.js";
import { LimitExceededError } from "../../src/graph/limits.js";
import { LoyaltyOfferDto, OrderStatusDto } from "./fixtures/data-dtos.js";
import { CompanyCheckDto, RefundPolicyDto } from "./fixtures/launch-dtos.js";
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
import { onAgent, onAction, onRouter, onStart, toFinish } from "./fixtures/paths.js";

/** #273 PR 1 — launches and joins in the AST: what the builder writes, and what it refuses. */

const flowOf = (workflow: abstract new () => unknown): readonly FlowPath[] => {
  const declaration = declarationOf(workflow);
  if (declaration?.kind !== NodeKind.Workflow) throw new TypeError("not a workflow");
  return declaration.options.flow;
};

const stepsOf = (workflow: abstract new () => unknown) => flowOf(workflow)[0]?.steps ?? [];

describe("#273: a launch and its join in the AST", () => {
  it("different agents: the targets as listed, repeats kept, maxConcurrency", () => {
    const launch = stepsOf(ResearchWorkflow).find((step) => step.kind === StepKind.Launch);
    expect(launch).toEqual({
      kind: StepKind.Launch,
      targetKind: NodeKind.Agent,
      targets: [PlanResearcherAgent, CriticAgent, CriticAgent],
      maxConcurrency: 3,
    });
  });

  it("the join keeps its .onError side paths", () => {
    const join = stepsOf(ScreeningWorkflow).find((step) => step.kind === StepKind.Join);
    expect(join).toEqual({
      kind: StepKind.Join,
      onError: [
        {
          error: LimitExceededError,
          path: {
            steps: toAction(NotifyOperatorAction).toFinish(ScreeningFailedWorkflowFinish).steps,
          },
        },
      ],
    });
  });

  it("one target after a list keeps its maxItems; whether it runs per item is the analyser's (#1270)", () => {
    const launch = stepsOf(ScreeningWorkflow).find((step) => step.kind === StepKind.Launch);
    expect(launch).toMatchObject({ targets: [CompanyAuditAgent], maxItems: 50 });
    expect(launch).not.toHaveProperty("perItem");
  });

  it("parallel actions without output: the join has no values", () => {
    const steps = stepsOf(CheckoutWorkflow);
    expect(steps.map((step) => step.kind)).toEqual([
      StepKind.To,
      StepKind.Launch,
      StepKind.Join,
      StepKind.To,
    ]);
    expect(steps[1]).toMatchObject({ targetKind: NodeKind.Action, targets: expect.any(Array) });
    expect(steps[2]).toEqual({ kind: StepKind.Join, onError: [] });
  });
});

describe("#273: the order around a launch holds for untyped code too (FlowSyntaxError)", () => {
  const launched = () => onAgent(PlannerAgent).toParallelAgents(PlanResearcherAgent);

  it("a launch is followed by .join()", () => {
    expect(() => launched().toAgent(CriticAgent)).toThrow(FlowSyntaxError);
    expect(() => launched().toAgent(CriticAgent)).toThrow(
      "a parallel launch is followed by .join()",
    );
  });

  it(".join() follows a launch, and .onError right after it is the join's", () => {
    expect(() => onAgent(PlannerAgent).join()).toThrow(".join() follows a parallel launch");
    const handled = launched()
      .join()
      .onError(LimitExceededError, toFinish(ScreeningFailedWorkflowFinish));
    expect(handled.steps.at(-1)).toMatchObject({ kind: StepKind.Join });
  });

  it(".onError between a launch and its join, and a second launch right after a join, are refused", () => {
    expect(() =>
      launched().onError(LimitExceededError, toFinish(ScreeningFailedWorkflowFinish)),
    ).toThrow("a parallel launch is followed by .join()");
    expect(() => launched().join().toParallelAgents(CriticAgent)).toThrow(
      "after .join() the path goes on with",
    );
  });

  it("targets are classes, the options last, the limits positive integers", () => {
    const planned = () => onAgent(PlannerAgent);
    expect(() => planned().toParallelAgents()).toThrow("takes one or more component classes");
    expect(() => planned().toParallelAgents("critic")).toThrow(
      "takes one or more component classes",
    );
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
    expect(() => onRouter(HelpDeskRouter).toParallelActions(SendReceiptAction)).toThrow(
      "a router launches agents only",
    );
    expect(() =>
      onStart(HelpDeskWorkflowStart).toRouter(HelpDeskRouter).toParallelActions(SendReceiptAction),
    ).toThrow("a router launches agents only");
    expect(onAction(ChargePaymentAction).toParallelActions(SendReceiptAction).steps).toHaveLength(
      1,
    );
  });
});

describe("#273: describe prints launches and joins in the grammar", () => {
  it("one call per line: the launch with its options, the join and its side path", () => {
    expect(flowLines(flowOf(ScreeningWorkflow))).toEqual([
      "onStart(ScreeningWorkflowStart)",
      "  .toAgent(ScreeningAgent)",
      "  .toParallelAgents(CompanyAuditAgent, { maxConcurrency: 3, maxItems: 50 })",
      "  .join()",
      "  .onError(LimitExceededError, toAction(NotifyOperatorAction)",
      "    .toFinish(ScreeningFailedWorkflowFinish))",
      "  .toAgent(RankerAgent)",
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
