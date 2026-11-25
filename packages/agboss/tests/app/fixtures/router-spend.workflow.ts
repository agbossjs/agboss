import { WorkflowStartTextDto } from "../../../src/dto/index.js";
import {
  Budget,
  BudgetScope,
  InMemoryFencedEffectRepository,
  Workflow,
  WorkflowStart,
  type BudgetHandler,
  inline,
  Ttl,
} from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { DecidedBy, Router } from "../../../src/flow/decorators/router.js";
import { usd, type Usd } from "../../../src/units/index.js";
import { onStart, toAction, toFinish } from "../../flow/fixtures/paths.js";
import { IdempotencyKeyEnvironment } from "../../helpers/idempotency-key.environment.js";
import { RecordingLogger } from "../../helpers/log.js";
import { RecoveryLog } from "../../infrastructure/fixtures/recovery.workflow.js";
import { TestApplicationDailyBudget, TestTenantDailyBudget } from "../../flow/fixtures/budgets.js";
import {
  ChargeOrderAction,
  ChargedWorkflowFinish,
  NotChargedWorkflowFinish,
} from "./fenced-effect.workflow.js";
import { WindowMemoryCheckpoints } from "./writes-window.application.js";
import { TestModelProvider } from "../../../src/testing/test-model-provider.js";

/**
 * #1090 — a model router before a charge: start, router (its decision costs money), charge,
 * finish. The execution's budget is one dollar, so a router that costs more stops at its call.
 */

@Budget({ name: "router-execution-budget", scope: BudgetScope.Execution })
export class RouterExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(1);
  }
}

@WorkflowStart({
  name: "routed-charge-workflow-start",
  description: "An order, routed by a model",
  input: WorkflowStartTextDto,
})
export class RoutedChargeWorkflowStart {}

@Router({
  name: "order-router",
  description: "Sends the order to its charge, or stops",
  decidedBy: DecidedBy.Model,
  model: "typesafe/jev-1.13",
  prompt: inline("Charge the order, or stop."),
  input: { message: WorkflowStartTextDto },
  maxVisits: 1,
  routes: [
    { target: ChargeOrderAction, prompt: "Charge the order" },
    { target: NotChargedWorkflowFinish, prompt: "Do not charge" },
  ],
})
export class OrderRouter {}

@Workflow({
  name: "routed-charge-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(RoutedChargeWorkflowStart)
      .toRouter(OrderRouter)
      .onRoute(toAction(ChargeOrderAction).toFinish(ChargedWorkflowFinish))
      .onRoute(toFinish(NotChargedWorkflowFinish)),
  ],
})
export class RoutedChargeWorkflow {}

@Application({
  name: "router-spend-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  environment: IdempotencyKeyEnvironment,
  workflows: [RoutedChargeWorkflow],
  observers: [RecoveryLog],
  budgets: [TestApplicationDailyBudget, TestTenantDailyBudget, RouterExecutionBudget],
  providers: [WindowMemoryCheckpoints, RecordingLogger, InMemoryFencedEffectRepository],
})
export class RouterSpendApplication {}
