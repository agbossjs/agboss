import { Application } from "../../../src/application/application.js";
import { ChatWorkflow } from "../../flow/fixtures/chat.fixture.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { EmptyEnvironment } from "../../../src/index.js";

/** A module with two applications: `--application` needs exactly one (#268). */
@Application({
  name: "first-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ChatWorkflow],
  budgets: TEST_BUDGETS,
})
export class FirstApplication {}

@Application({
  name: "second-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ChatWorkflow],
  budgets: TEST_BUDGETS,
})
export class SecondApplication {}
