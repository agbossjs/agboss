import { Injectable } from "../../../src/components/decorators.js";
import { action, route, start, toFinish } from "../../../src/flow/builder.js";
import { ExecutionContext } from "../../../src/flow/context/execution-context.js";
import { Action } from "../../../src/flow/decorators/action.js";
import { Agent } from "../../../src/flow/decorators/agent.js";
import { DecidedBy, Router } from "../../../src/flow/decorators/router.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import { optional } from "../../../src/flow/dto-wrappers.js";
import type { InputOf, OutputOf, Route } from "../../../src/flow/generated-types.js";
import type { ActionHandler, RouterHandler } from "../../../src/flow/handlers.js";
import { ChargeResultDto, CreditApprovalDto, CreditOrderDto } from "./credit-dtos.js";
import { WorkflowStartTextDto } from "./dtos.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "./budgets.js";

/** #280 — the credit-limit flow: a code router inside a model router's route. */

/** The credit service is down: the domain error a code router's `route()` lets out. */
export class CreditServiceUnavailableError extends Error {}

/** The customers' credit limits (a service: the I/O a code router calls). */
@Injectable()
export class CreditService {
  limitOf(customerId: string): Promise<number> {
    return Promise.resolve(customerId === "big-spender" ? 10_000 : 100);
  }
}

@WorkflowStart({
  name: "credit-workflow-start",
  description: "A customer's message",
  input: WorkflowStartTextDto,
})
export class CreditWorkflowStart {}

@Agent({
  name: "order-intake-agent",
  description: "Reads the order from the message",
  prompt: "Read the order.",
  model: "moonshotai/kimi-k2.6",
  input: {
    message: WorkflowStartTextDto,
  },
  output: CreditOrderDto,
})
export class OrderIntakeAgent {}

@Agent({
  name: "approval-agent",
  description: "Approves a large order",
  prompt: "Approve the order or not.",
  model: "moonshotai/kimi-k2.6",
  input: {
    order: CreditOrderDto,
  },
  output: CreditApprovalDto,
})
export class ApprovalAgent {}

@Action({
  name: "charge-card-action",
  description: "Charges the customer's card for the order",
  input: {
    order: CreditOrderDto,
    approval: optional(CreditApprovalDto), // present after ApprovalAgent
  },
  output: ChargeResultDto,
})
export class ChargeCardAction implements ActionHandler<ChargeCardAction> {
  execute(input: InputOf<ChargeCardAction>): Promise<OutputOf<ChargeCardAction>> {
    return Promise.resolve({ chargeId: `charge-${input.order.value.customerId}` });
  }
}

@WorkflowFinish({
  name: "credit-workflow-finish",
  description: "The charge",
  output: ChargeResultDto,
})
export class CreditWorkflowFinish {}

@WorkflowFinish({
  name: "order-held-workflow-finish",
  description: "The order, held until the credit service answers",
  output: CreditOrderDto,
})
export class OrderHeldWorkflowFinish {}

@WorkflowFinish({
  name: "no-order-workflow-finish",
  description: "The message, not an order",
  output: WorkflowStartTextDto,
})
export class NoOrderWorkflowFinish {}

/** What the code router saw of its step, per visit (read through the injected context). */
export const creditDecisions: { nodeId: string; visitNumber: number; key: string }[] = [];

@Router({
  name: "credit-limit-router",
  description: "Sends large orders for approval, charges the rest",
  decidedBy: DecidedBy.Code,
  input: {
    order: CreditOrderDto,
  },
  routes: [{ target: ApprovalAgent }, { target: ChargeCardAction }],
  deps: [ExecutionContext, CreditService],
})
export class CreditLimitRouter implements RouterHandler<CreditLimitRouter> {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly creditService: CreditService,
  ) {}

  async route(input: InputOf<CreditLimitRouter>): Promise<Route<CreditLimitRouter>> {
    const { step } = this.executionContext;
    creditDecisions.push({
      nodeId: step.nodeId,
      visitNumber: step.visitNumber,
      key: step.idempotencyKey,
    });
    const limit = await this.creditService.limitOf(input.order.value.customerId);
    return input.order.value.total > limit ? ApprovalAgent : ChargeCardAction;
  }
}

@Router({
  name: "desk-router",
  description: "Sends an order to the intake, ends on anything else",
  decidedBy: DecidedBy.Model,
  model: "typesafe/jev-1.13",
  prompt: "Pick who handles the customer's message.",
  input: {
    message: WorkflowStartTextDto,
  },
  routes: [
    { target: OrderIntakeAgent, prompt: "The customer wants to place an order" },
    { target: NoOrderWorkflowFinish, prompt: "Stop and hand the message over: it is not an order" },
  ],
})
export class DeskRouter {}

export const creditPaths = [
  start(CreditWorkflowStart)
    .returns(WorkflowStartTextDto)
    .toRouter(DeskRouter)
    .chooseOne(
      route(OrderIntakeAgent)
        .returns(CreditOrderDto)
        .toRouter(CreditLimitRouter)
        .onError(CreditServiceUnavailableError, toFinish(OrderHeldWorkflowFinish))
        .chooseOne(
          route(ApprovalAgent)
            .returns(CreditApprovalDto)
            .toAction(ChargeCardAction),
          route(ChargeCardAction),
        ),
      route(NoOrderWorkflowFinish),
    ),

  // two ways in (ApprovalAgent, CreditLimitRouter) → its own path
  action(ChargeCardAction)
    .returns(ChargeResultDto)
    .toFinish(CreditWorkflowFinish),
] as const;

@Workflow({
  name: "credit-workflow",
  version: "1.0.0",
  flow: creditPaths,
  providers: [CreditService],
})
export class CreditWorkflow {}

@Application({
  name: "credit-application",
  version: "1.0.0",
  workflows: [CreditWorkflow],
  budgets: TEST_BUDGETS,
})
export class CreditApplication {}

/** The same rule written as a model router: the flow is the same for both kinds (#280 AC5). */
@Router({
  name: "credit-limit-by-model-router",
  description: "Sends large orders for approval, charges the rest",
  decidedBy: DecidedBy.Model,
  model: "typesafe/jev-1.13",
  input: {
    order: CreditOrderDto,
  },
  routes: [
    { target: ApprovalAgent, prompt: "The order is over the customer's credit limit" },
    { target: ChargeCardAction, prompt: "The order is within the customer's credit limit" },
  ],
})
export class CreditLimitByModelRouter {}

export const creditByModelPaths = [
  start(CreditWorkflowStart)
    .returns(WorkflowStartTextDto)
    .toRouter(DeskRouter)
    .chooseOne(
      route(OrderIntakeAgent)
        .returns(CreditOrderDto)
        .toRouter(CreditLimitByModelRouter)
        .chooseOne(
          route(ApprovalAgent)
            .returns(CreditApprovalDto)
            .toAction(ChargeCardAction),
          route(ChargeCardAction),
        ),
      route(NoOrderWorkflowFinish),
    ),
  action(ChargeCardAction)
    .returns(ChargeResultDto)
    .toFinish(CreditWorkflowFinish),
] as const;

@Workflow({
  name: "credit-by-model-workflow",
  version: "1.0.0",
  flow: creditByModelPaths,
})
export class CreditByModelWorkflow {}

@Application({
  name: "credit-by-model-application",
  version: "1.0.0",
  workflows: [CreditByModelWorkflow],
  budgets: TEST_BUDGETS,
})
export class CreditByModelApplication {}
