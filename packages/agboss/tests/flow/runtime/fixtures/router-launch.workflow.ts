import {
  Agent,
  DecidedBy,
  optional,
  Router,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type Tracked,
  inline,
  Ttl,
} from "../../../../src/index.js";
import { WorkflowStartTextDto } from "../../fixtures/dtos.js";
import { Application } from "../../../../src/application/application.js";
import { usd, type Usd } from "../../../../src/units/index.js";
import {
  TEST_BUDGETS,
  TestApplicationDailyBudget,
  TestTenantDailyBudget,
} from "../../fixtures/budgets.js";
import { Budget, BudgetScope, type BudgetHandler } from "../../../../src/budgets/budget.js";
import { CustomerReplyDto, LoyaltyOfferDto, OrderStatusDto } from "../../fixtures/data-dtos.js";
import {
  HelpDeskRouter,
  HelpDeskWorkflowFinish,
  LoyaltyOfferAgent,
  OrderLookupAgent,
  RefundPolicyAgent,
} from "../../fixtures/launch.fixture.js";
import { RefundPolicyDto } from "../../fixtures/launch-dtos.js";
import { onStart, skip, toAgent, toRouter } from "../../../helpers/flow.js";
import { StepError } from "../../../../src/core/error-families/step-errors.js";
import { TestModelProvider } from "../../../../src/testing/test-model-provider.js";

/**
 * #273 PR 2 — routers before a launch, beside the issue's help desk: a chat-model router whose
 * routes are all `OnDemand` (all "no" launches nothing — a decision error), a code router that
 * answers wrongly on purpose, and the help desk one at a time under a run budget (a `Skip` branch
 * hitting a limit fails the step).
 */

@WorkflowStart({
  name: "picky-workflow-start",
  description: "A customer's message",
  input: WorkflowStartTextDto,
})
export class PickyWorkflowStart {}

@Router({
  name: "picky-router",
  description: "Picks who answers, on a chat model",
  decidedBy: DecidedBy.Model,
  model: "moonshotai/kimi-k2.6",
  prompt: inline("Pick everyone needed for the customer's message."),
  input: { message: WorkflowStartTextDto },
  routes: [
    { target: RefundPolicyAgent, prompt: "The message is about returns" },
    { target: LoyaltyOfferAgent, prompt: "The customer is loyal" },
  ],
})
export class PickyRouter {}

@Agent({
  name: "picky-answer-agent",
  description: "Answers from what was launched",
  prompt: inline("Answer."),
  model: "moonshotai/kimi-k2.6",
  input: {
    message: WorkflowStartTextDto,
    refund: optional(RefundPolicyDto),
    loyalty: optional(LoyaltyOfferDto),
  },
  output: CustomerReplyDto,
})
export class PickyAnswerAgent {}

@WorkflowFinish({
  name: "picky-workflow-finish",
  description: "The reply",
  output: CustomerReplyDto,
})
export class PickyWorkflowFinish {}

@Workflow({
  name: "picky-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(PickyWorkflowStart)
      .inParallel([
        toRouter(PickyRouter).chooseMany([toAgent(RefundPolicyAgent), toAgent(LoyaltyOfferAgent)]),
      ])
      .join()
      .toAgent(PickyAnswerAgent)
      .toFinish(PickyWorkflowFinish),
  ],
})
export class PickyWorkflow {}

@Application({
  name: "picky-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  workflows: [PickyWorkflow],
  budgets: TEST_BUDGETS,
})
export class PickyApplication {}

@WorkflowStart({
  name: "strict-workflow-start",
  description: "A message saying how the router answers",
  input: WorkflowStartTextDto,
})
export class StrictWorkflowStart {}

/** Answers what the message asks for: a list, one class, a target outside its routes, nothing. */
@Router({
  name: "strict-router",
  description: "Answers as told",
  decidedBy: DecidedBy.Code,
  input: { message: WorkflowStartTextDto },
  routes: [RefundPolicyAgent, LoyaltyOfferAgent],
})
export class StrictRouter {
  route(input: { readonly message: Tracked<WorkflowStartTextDto> }): unknown {
    switch (input.message.text) {
      case "both":
        return [LoyaltyOfferAgent, RefundPolicyAgent];
      case "one":
        return LoyaltyOfferAgent;
      case "ghost":
        return [OrderLookupAgent];
      default:
        return [];
    }
  }
}

@Workflow({
  name: "strict-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(StrictWorkflowStart)
      .inParallel([
        toRouter(StrictRouter).chooseMany([
          toAgent(RefundPolicyAgent),
          toAgent(LoyaltyOfferAgent).onError(StepError, skip()),
        ]),
      ])
      .join()
      .toAgent(PickyAnswerAgent)
      .toFinish(PickyWorkflowFinish),
  ],
})
export class StrictWorkflow {}

@Application({
  name: "strict-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  workflows: [StrictWorkflow],
  budgets: TEST_BUDGETS,
})
export class StrictApplication {}

@WorkflowStart({
  name: "budget-desk-workflow-start",
  description: "A customer's message",
  input: WorkflowStartTextDto,
})
export class BudgetDeskWorkflowStart {}

@Agent({
  name: "budget-answer-agent",
  description: "Writes the reply from the branches' results",
  prompt: inline("Write the reply."),
  model: "moonshotai/kimi-k2.6",
  input: {
    order: OrderStatusDto,
    refund: optional(RefundPolicyDto),
    loyalty: optional(LoyaltyOfferDto),
  },
  output: CustomerReplyDto,
})
export class BudgetAnswerAgent {}

/** The help desk one branch at a time, 0.05 USD per run. */
@Workflow({
  name: "budget-desk-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(BudgetDeskWorkflowStart)
      .inParallel(
        [
          toAgent(OrderLookupAgent),
          toAgent(LoyaltyOfferAgent).onError(StepError, skip()),
          toRouter(HelpDeskRouter).chooseMany([toAgent(RefundPolicyAgent)]),
        ],
        { maxConcurrency: 1 },
      )
      .join()
      .toAgent(BudgetAnswerAgent)
      .toFinish(HelpDeskWorkflowFinish),
  ],
})
export class BudgetDeskWorkflow {}

/** $0.05 an execution: one dear branch spends it. */
@Budget({ name: "budget-desk-execution-budget", scope: BudgetScope.Execution })
export class BudgetDeskExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(0.05);
  }
}

@Application({
  name: "budget-desk-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  workflows: [BudgetDeskWorkflow],
  budgets: [TestApplicationDailyBudget, TestTenantDailyBudget, BudgetDeskExecutionBudget],
})
export class BudgetDeskApplication {}
