import {
  Agent,
  ENV,
  Injectable,
  Workflow,
  type Environment,
  type OnWorkflowStart,
} from "../../../../src/index.js";
import { ChatStart, Reply, settingsDefaults } from "../app/settings.workflow.js";
import { start } from "../../../helpers/flow.js";
import { WorkflowStartTextDto } from "../../../../src/dto/index.js";
import { Application } from "../../../../src/application/application.js";
import { TEST_BUDGETS } from "../../../flow/fixtures/budgets.js";

/** An observer — not a tool — that reads the app's environment; created when the app starts. */
@Injectable({ deps: [ENV] })
export class RunLog implements OnWorkflowStart {
  constructor(readonly env: Environment) {}

  onWorkflowStart(): void {
    // a real one would log to `this.env`'s sink
  }
}

/** An agent with no tools: nothing but the observer injects ENV. */
@Agent({
  name: "greeter-agent",
  description: "Greets",
  prompt: "Greet the user.",
  model: "test/greeter",
  price: { inputPerMTok: 1, outputPerMTok: 10 },
})
export class Greeter {}

/** #239: ENV injected only by an observer, and no `environments/` folder next to this file. */
@Workflow({
  name: "observed-workflow",
  version: "1.0.0",
  flow: [
    start(ChatStart)
      .returns(WorkflowStartTextDto)
      .toAgent(Greeter)
      .toFinish(Reply),
  ],
  defaults: settingsDefaults,
  observers: [RunLog],
})
export class ObservedApp {}

@Application({
  name: "observed-application",
  version: "1.0.0",
  workflows: [ObservedApp],
  budgets: TEST_BUDGETS,
})
export class ObservedApplication {}
