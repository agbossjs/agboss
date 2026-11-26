// `agboss check` fixture (#272 PR 3): a v2 workflow — the S4 threshold of the framework's tests
import { Application } from "../../../../agboss/src/index.js";
import { TEST_BUDGETS } from "../../../../agboss/tests/flow/fixtures/budgets.js";
import { PartsWorkflow } from "../../../../agboss/tests/flow/fixtures/wide.fixture.js";
import { TestModelProvider } from "../../../../agboss/src/testing/test-model-provider.js";

export { PartsWorkflow };

/** The application `agboss --application` loads (#268): this workflow alone. */
@Application({
  modelProvider: TestModelProvider,
  name: "parts-application",
  version: "1.0.0",
  workflows: [PartsWorkflow],
  budgets: TEST_BUDGETS,
})
export class PartsApplication {}
