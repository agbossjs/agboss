import { EmptyEnvironment } from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import {
  PaidChildWorkflow,
  PaidHoldWorkflow,
  PaidItemsWorkflow,
  PaidLaunchWorkflow,
  PaidLevelWorkflow,
  PaidRaceWorkflow,
} from "./paid-launches.workflow.js";
import {
  PaidActionWorkflow,
  PaidAgentWorkflow,
  PaidDeclinedWorkflow,
  PaidFinishWorkflow,
  PaidLimitWorkflow,
  PaidRouterWorkflow,
} from "./paid-steps.workflow.js";
import { PaidNestedWorkflow, PaidRefundWorkflow } from "./paid-nested.workflow.js";
import { PaidStepsLog } from "./paid-steps.actions.js";

/**
 * #634 — every paid step's workflow on the test budgets (the execution may spend $100, the tenant
 * and the application $1000 a day); the in-memory stores, shared by a test's instances.
 */
@Application({
  name: "paid-steps-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [
    PaidActionWorkflow,
    PaidRouterWorkflow,
    PaidAgentWorkflow,
    PaidFinishWorkflow,
    PaidDeclinedWorkflow,
    PaidLimitWorkflow,
    PaidChildWorkflow,
    PaidItemsWorkflow,
    PaidLevelWorkflow,
    PaidLaunchWorkflow,
    PaidRaceWorkflow,
    PaidHoldWorkflow,
    PaidNestedWorkflow,
    PaidRefundWorkflow,
  ],
  observers: [PaidStepsLog],
  budgets: TEST_BUDGETS,
})
export class PaidStepsApplication {}
