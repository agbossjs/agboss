import { EmptyEnvironment } from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { ExemptionsLog } from "./paid-exemptions.actions.js";
import {
  HeldLaunchWorkflow,
  HeldLimitWorkflow,
  JoinLimitWorkflow,
  LimitLaunchWorkflow,
  NestedLimitWorkflow,
  RebookWorkflow,
  RefundHandledWorkflow,
  RefundStepWorkflow,
} from "./paid-exemptions.workflow.js";
import { PaidStepsLog } from "./paid-steps.actions.js";

/**
 * #656 — the workflows that scope the budget's exemptions, on the test budgets (the execution may
 * spend $100); the in-memory stores, shared by a test's instances.
 */
@Application({
  name: "paid-exemptions-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [
    LimitLaunchWorkflow,
    JoinLimitWorkflow,
    HeldLimitWorkflow,
    HeldLaunchWorkflow,
    RefundStepWorkflow,
    RebookWorkflow,
    NestedLimitWorkflow,
    RefundHandledWorkflow,
  ],
  observers: [PaidStepsLog, ExemptionsLog],
  budgets: TEST_BUDGETS,
})
export class PaidExemptionsApplication {}
