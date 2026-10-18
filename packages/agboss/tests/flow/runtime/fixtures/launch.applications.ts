import { Application } from "../../../../src/application/application.js";
import { EmptyEnvironment } from "../../../../src/index.js";
import { TEST_BUDGETS } from "../../fixtures/budgets.js";
import {
  CheckoutWorkflow,
  HelpDeskWorkflow,
  OffersWorkflow,
  ResearchWorkflow,
  ScreeningWorkflow,
} from "../../fixtures/launch.fixture.js";

/** #273 PR 2: the issue's four launches and the code router's, each run as an application. */

@Application({
  name: "research-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ResearchWorkflow],
  budgets: TEST_BUDGETS,
})
export class ResearchApplication {}

@Application({
  name: "screening-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ScreeningWorkflow],
  budgets: TEST_BUDGETS,
})
export class ScreeningApplication {}

@Application({
  name: "checkout-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [CheckoutWorkflow],
  budgets: TEST_BUDGETS,
})
export class CheckoutApplication {}

@Application({
  name: "help-desk-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [HelpDeskWorkflow],
  budgets: TEST_BUDGETS,
})
export class HelpDeskApplication {}

@Application({
  name: "offers-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [OffersWorkflow],
  budgets: TEST_BUDGETS,
})
export class OffersApplication {}
