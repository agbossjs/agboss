// `agboss check` fixture (#376 AC1): an application module outside a src/ that does not export its
// workflow — type generation finds no workflow to type (no-flow)
import { Application } from "../../../../../agboss/src/index.js";
import { TEST_BUDGETS } from "../../../../../agboss/tests/flow/fixtures/budgets.js";
import { TripWorkflow } from "./trip.workflow.js";
import { TestModelProvider } from "../../../../../agboss/src/testing/test-model-provider.js";

@Application({
  modelProvider: TestModelProvider,
  name: "trip-only-application",
  version: "1.0.0",
  workflows: [TripWorkflow],
  budgets: TEST_BUDGETS,
})
export class TripOnlyApplication {}
