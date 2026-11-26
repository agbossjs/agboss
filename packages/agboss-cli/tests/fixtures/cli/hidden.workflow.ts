// `agboss check` fixture (#272 PR 3): a v2 workflow whose types need classes no module exports
import { Application } from "../../../../agboss/src/index.js";
import { TEST_BUDGETS } from "../../../../agboss/tests/flow/fixtures/budgets.js";
import { HiddenWorkflow } from "../../../../agboss/tests/flow/fixtures/unexported.fixture.js";
import { TestModelProvider } from "../../../../agboss/src/testing/test-model-provider.js";

export { HiddenWorkflow };

/** The application `agboss --application` loads (#268): this workflow alone. */
@Application({
  modelProvider: TestModelProvider,
  name: "hidden-application",
  version: "1.0.0",
  workflows: [HiddenWorkflow],
  budgets: TEST_BUDGETS,
})
export class HiddenApplication {}
