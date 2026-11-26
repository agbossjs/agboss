import { TEST_BUDGETS } from "../../../../agboss/tests/flow/fixtures/budgets.js";
import {
  Agent,
  Application,
  DecidedBy,
  Router,
  Workflow,
  inline,
  Ttl,
} from "../../../../agboss/src/index.js";
import { WorkflowStartTextDto } from "../../../../agboss/src/dto/index.js";
import { testDefaults } from "../../../../agboss/tests/helpers.js";
import { onStart, toAgent, toFinish } from "../../../../agboss/tests/helpers/flow.js";
import {
  NoAnswer,
  TestAnswer,
  TestChat,
} from "../../../../agboss/tests/fixtures/test-flow/test.flow.js";
import { TestModelProvider } from "../../../../agboss/src/testing/test-model-provider.js";

// `agboss check` fixture (#199): a {{typo}} in the agent's prompt file and one in the router's prompt, and an unused key (#1347c)

@Agent({
  name: "scout-agent",
  description: "Scouts job boards",
  model: "test/alpha",
  prompt: "./typo.prompt.md",
  promptVariables: { boardCount: "2", spare: "unused" },
})
export class Scout {}

@Router({
  name: "main-router",
  description: "Sends the task to the scout, or ends",
  decidedBy: DecidedBy.Model,
  prompt: inline("Pick one.\nThe boards: {{bords}}"),
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
  historyTtl: Ttl.Forever,
  defaults: testDefaults,
  flow: [
    onStart(TestChat)
      .toRouter(Main)
      .onRoute(
        toAgent(Scout)
          .toFinish(TestAnswer),
      )
      .onRoute(toFinish(NoAnswer)),
  ],
  promptVariables: { boards: "LinkedIn, AllJobs" },
})
export class BadPrompts {}

/** The application `agboss --application` loads (#268): this workflow alone. */
@Application({
  name: "prompts-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  workflows: [BadPrompts],
  budgets: TEST_BUDGETS,
})
export class PromptsApplication {}
