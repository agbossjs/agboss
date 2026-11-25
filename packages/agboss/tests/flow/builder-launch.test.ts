import { ConfigError } from "../../src/core/error-families/config-errors.js";
import { describe, expect, it } from "vitest";
import { NodeKind, StepKind, type FlowPath } from "../../src/flow/ast.js";
import { toAction, toRouter, toAgent } from "../../src/flow/builder.js";
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
  RefundPolicyAgent,
  ResearchWorkflow,
  ScreeningFailedWorkflowFinish,
  ScreeningWorkflow,
  SendReceiptAction,
  UpdateCrmAction,
  ReserveGoodsAction,
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
  it("different agents: the branches as listed, repeats kept, maxConcurrency", () => {
    const launch = stepsOf(ResearchWorkflow).find((step) => step.kind === StepKind.InParallel);
    expect(launch).toMatchObject({
      kind: StepKind.InParallel,
      branches: [
        { target: PlanResearcherAgent, targetKind: NodeKind.Agent, skip: [] },
        { target: CriticAgent, targetKind: NodeKind.Agent, skip: [] },
        { target: CriticAgent, targetKind: NodeKind.Agent, skip: [] },
      ],
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

  it("one target per item keeps its takeFirst; whether it has a list to run over is the analyser's", () => {
    const launch = stepsOf(ScreeningWorkflow).find((step) => step.kind === StepKind.ForEachItem);
    expect(launch).toMatchObject({
      branch: { target: CompanyAuditAgent, targetKind: NodeKind.Agent },
      takeFirst: 50,
      maxConcurrency: 3,
    });
    expect(launch).not.toHaveProperty("maxItems");
  });

  it("parallel actions without output: the join has no values", () => {
    const steps = stepsOf(CheckoutWorkflow);
    expect(steps.map((step) => step.kind)).toEqual([
      StepKind.To,
      StepKind.InParallel,
      StepKind.Join,
      StepKind.To,
    ]);
    expect(steps[1]).toMatchObject({
      branches: [
        { targetKind: NodeKind.Action },
        { targetKind: NodeKind.Action },
        { targetKind: NodeKind.Action },
      ],
    });
    expect(steps[2]).toEqual({ kind: StepKind.Join, onError: [] });
  });
});

describe("#273: the order around a launch holds for untyped code too (ConfigError.FlowSyntax)", () => {
  const launched = () => onAgent(PlannerAgent).inParallel([toAgent(PlanResearcherAgent)]);

  it("a launch is followed by .join()", () => {
    expect(() => launched().toAgent(CriticAgent)).toThrow(ConfigError.FlowSyntax);
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
    expect(() =>
      launched()
        .join()
        .inParallel([toAgent(CriticAgent)]),
    ).toThrow("after .join() the path goes on with");
  });

  it("branches are classes, the options last, the limits positive integers", () => {
    const planned = () => onAgent(PlannerAgent);
    expect(() => planned().inParallel([])).toThrow("takes an array of one or more branches");
    expect(() => planned().inParallel([toAgent(CriticAgent)], { maxConcurrency: 0 })).toThrow(
      "(…, { maxConcurrency }) takes a positive integer",
    );
    expect(() => planned().forEachItem(toAgent(CriticAgent), { takeFirst: 1.5 })).toThrow(
      "(…, { takeFirst }) takes a positive integer",
    );
  });

  it("a router's launch is a branch of .inParallel([…]): toRouter(R).chooseMany([…])", () => {
    expect(
      onStart(HelpDeskWorkflowStart).inParallel([
        toRouter(HelpDeskRouter).chooseMany([toAgent(RefundPolicyAgent)]),
      ]).steps,
    ).toHaveLength(1);
    expect(
      onAction(ChargePaymentAction).inParallel([toAction(SendReceiptAction)]).steps,
    ).toHaveLength(1);
  });
});

describe("#273: describe prints launches and joins in the grammar", () => {
  it("one call per line: the launch with its options, the join and its side path", () => {
    expect(flowLines(flowOf(ScreeningWorkflow))).toEqual([
      "onStart(ScreeningWorkflowStart)",
      "  .toAgent(ScreeningAgent)",
      "  .forEachItem(toAgent(CompanyAuditAgent), { takeFirst: 50, maxConcurrency: 3 })",
      "  .join()",
      "  .onError(LimitExceededError, toAction(NotifyOperatorAction)",
      "    .toFinish(ScreeningFailedWorkflowFinish))",
      "  .toAgent(RankerAgent)",
      "  .toFinish(RankingWorkflowFinish)",
    ]);
  });

  it("a router's launch and parallel actions", () => {
    expect(flowLines(flowOf(HelpDeskWorkflow))).toContain(
      "  .inParallel([toAgent(OrderLookupAgent), toAgent(LoyaltyOfferAgent).onError(StepError, skip()), toRouter(HelpDeskRouter).chooseMany([toAgent(RefundPolicyAgent)])])",
    );
    expect(flowLines(flowOf(CheckoutWorkflow))).toContain(
      "  .inParallel([toAction(SendReceiptAction), toAction(UpdateCrmAction), toAction(ReserveGoodsAction)], { maxConcurrency: 3 })",
    );
  });
});
