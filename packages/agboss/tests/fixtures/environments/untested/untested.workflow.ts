import { Workflow } from "../../../../src/index.js";
import { WorkflowStartTextDto } from "../../../../src/dto/index.js";
import { Application } from "../../../../src/application/application.js";
import { start } from "../../../helpers/flow.js";
import { TEST_BUDGETS } from "../../../flow/fixtures/budgets.js";
import { ApiClient, ChatStart, Clerk, Reply, settingsDefaults } from "../app/settings.workflow.js";
import { SettingsEnvironment } from "../app/environments/app.environment.js";

/** The same service, but its application has only a dev environment: no test.environment.ts. */
@Workflow({
  name: "untested-workflow",
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
export class UntestedApp {}

@Application({
  name: "untested-application",
  version: "1.0.0",
  environment: SettingsEnvironment,
  workflows: [UntestedApp],
  budgets: TEST_BUDGETS,
})
export class UntestedApplication {}
