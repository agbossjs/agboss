import { Application } from "../../../../src/application/application.js";
import { ChatWorkflow } from "../../../flow/fixtures/chat.fixture.js";
import { TEST_BUDGETS } from "../../../flow/fixtures/budgets.js";
import { EmptyEnvironment } from "../../../../src/index.js";

/** An application module: `agboss --application <path>` loads its one exported @Application (#268). */
@Application({
  name: "solo-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ChatWorkflow],
  budgets: TEST_BUDGETS,
})
export class SoloApplication {}
