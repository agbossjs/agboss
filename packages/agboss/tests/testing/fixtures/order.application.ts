import { Application } from "../../../src/application/application.js";
import { EmptyEnvironment } from "../../../src/index.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { OrderWorkflow } from "../../flow/fixtures/order.fixture.js";

/** #272 example 3 as an application: actions only, an error handler and a rollback (#262 AC9, AC10). */
@Application({
  name: "order-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [OrderWorkflow],
  budgets: TEST_BUDGETS,
})
export class OrderApplication {}
