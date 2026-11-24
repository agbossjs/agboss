import { Agent, ApplicationContext, Observer, Workflow, inline, Ttl } from "../../../../src/index.js";
import { ChatStart, Reply, settingsDefaults } from "../app/settings.workflow.js";
import { onStart } from "../../../helpers/flow.js";
import { Application } from "../../../../src/application/application.js";
import { TEST_BUDGETS } from "../../../flow/fixtures/budgets.js";

/** An observer — not a tool — that reads the app's environment; created when the app starts. */
@Observer({ deps: [ApplicationContext] })
export class RunLog {
  constructor(readonly applicationContext: ApplicationContext) {}

  onExecutionStart(): void {
    // a real one would log to the sink of `this.applicationContext.environment`
  }
}

/** An agent with no tools: nothing but the observer reads the environment. */
@Agent({
  name: "greeter-agent",
  description: "Greets",
  prompt: inline("Greet the user."),
  model: "test/greeter",
  price: { inputPerMTok: 1, outputPerMTok: 10 },
})
export class Greeter {}

/** #239: the environment read only by an observer, and no `environments/` folder next to this file. */
@Workflow({
  name: "observed-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(ChatStart)
      .toAgent(Greeter)
      .toFinish(Reply),
  ],
  defaults: settingsDefaults,
})
export class ObservedApp {}

// @ts-expect-error — environment is required (#261): this fixture omits it on purpose, to test
// what an untyped caller gets at run time (an empty environment)
@Application({
  name: "observed-application",
  version: "1.0.0",
  workflows: [ObservedApp],
  observers: [RunLog],
  budgets: TEST_BUDGETS,
})
export class ObservedApplication {}
