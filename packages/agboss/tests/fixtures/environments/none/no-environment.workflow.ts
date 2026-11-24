import { Workflow, Ttl } from "../../../../src/index.js";
import { ApiClient, ChatStart, Clerk, Reply, settingsDefaults } from "../app/settings.workflow.js";
import { onStart } from "../../../helpers/flow.js";
import { Application } from "../../../../src/application/application.js";
import { TEST_BUDGETS } from "../../../flow/fixtures/budgets.js";

/** The same service reading the environment, but no `environments/` folder next to this file. */
@Workflow({
  name: "no-environment-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(ChatStart)
      .toAgent(Clerk)
      .toFinish(Reply),
  ],
  defaults: settingsDefaults,
  providers: [ApiClient],
})
export class NoEnvironmentApp {}

// @ts-expect-error — environment is required (#261): this fixture omits it on purpose, to test
// what an untyped caller gets at run time (an empty environment)
@Application({
  name: "no-environment-application",
  version: "1.0.0",
  workflows: [NoEnvironmentApp],
  budgets: TEST_BUDGETS,
})
export class NoEnvironmentApplication {}
