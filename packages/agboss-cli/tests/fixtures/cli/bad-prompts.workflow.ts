import { TEST_BUDGETS } from "../../../../agboss/tests/flow/fixtures/budgets.js";
import {
  Agent,
  Application,
  DecidedBy,
  EmptyEnvironment,
  Router,
  Workflow,
} from "../../../../agboss/src/index.js";
import { WorkflowStartTextDto } from "../../../../agboss/src/dto/index.js";
import { testDefaults } from "../../../../agboss/tests/helpers.js";
import { route, start } from "../../../../agboss/tests/helpers/flow.js";
import {
  NoAnswer,
  TestAnswer,
  TestChat,
} from "../../../../agboss/tests/fixtures/test-flow/test.flow.js";

// `agboss check` fixture (#199): a {{typo}} in the agent's prompt file and one in the router's prompt

@Agent({
  name: "scout-agent",
  description: "Scouts job boards",
  model: "test/alpha",
  promptUrls: ["./typo.prompt.md"],
  promptVariables: { boardCount: "2" },
})
export class Scout {}

@Router({
  name: "main-router",
  description: "Sends the task to the scout, or ends",
  decidedBy: DecidedBy.Model,
  prompt: "Pick one.\nThe boards: {{bords}}",
  model: "typesafe/jev-1.13",
  input: { message: WorkflowStartTextDto },
  maxVisits: 4,
  routes: [
    { prompt: "Job boards to scout", target: Scout },
    { prompt: "Stop without an answer: nothing to scout", target: NoAnswer },
  ],
})
export class Main {}

@Workflow({
  name: "prompts-workflow",
  version: "1.0.0",
  defaults: testDefaults,
  flow: [
    start(TestChat)
      .returns(WorkflowStartTextDto)
      .toRouter(Main)
      .chooseOne(
        route(Scout)
          .toFinish(TestAnswer),
        route(NoAnswer),
      ),
  ],
  promptVariables: { boards: "LinkedIn, AllJobs" },
})
export class BadPrompts {}

/** The application `agboss --application` loads (#268): this workflow alone. */
@Application({
  name: "prompts-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [BadPrompts],
  budgets: TEST_BUDGETS,
})
export class PromptsApplication {}
