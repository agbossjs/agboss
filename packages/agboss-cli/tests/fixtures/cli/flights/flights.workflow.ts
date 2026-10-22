// `agboss check` fixture (#371): an application of two workflows, each with its own
// FlightBookingDto — the names clash ([dto.duplicate-name])
import { Application, EmptyEnvironment } from "../../../../../agboss/src/index.js";
import { TEST_BUDGETS } from "../../../../../agboss/tests/flow/fixtures/budgets.js";
import { ApprovalsWorkflow } from "./approvals.workflow.js";
import { TripWorkflow } from "./trip.workflow.js";

// a module outside a src/ is generated alone: its workflows are found among its exports
export { ApprovalsWorkflow, TripWorkflow };

@Application({
  name: "flights-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [TripWorkflow, ApprovalsWorkflow],
  budgets: TEST_BUDGETS,
})
export class FlightsApplication {}
