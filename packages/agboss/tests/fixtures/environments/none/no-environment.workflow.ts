import { Workflow } from "../../../../src/index.js";
import { ApiClient, ChatStart, Clerk, Reply, settingsDefaults } from "../app/settings.workflow.js";
import { start } from "../../../helpers/flow.js";
import { WorkflowStartTextDto } from "../../../../src/dto/index.js";
import { Application } from "../../../../src/application/application.js";
import { TEST_BUDGETS } from "../../../flow/fixtures/budgets.js";

/** The same service injecting ENV, but no `environments/` folder next to this file. */
@Workflow({
  name: "no-environment-workflow",
  version: "1.0.0",
  flow: [
    start(ChatStart)
      .returns(WorkflowStartTextDto)
      .toAgent(Clerk)
      .toFinish(Reply),
  ],
  defaults: settingsDefaults,
  providers: [ApiClient],
})
export class NoEnvironmentApp {}

// @ts-expect-error — environment is required (#261): this fixture omits it on purpose, to test
// what an untyped caller gets at run time ([di.missing-environment])
@Application({
  name: "no-environment-application",
  version: "1.0.0",
  workflows: [NoEnvironmentApp],
  budgets: TEST_BUDGETS,
})
export class NoEnvironmentApplication {}
