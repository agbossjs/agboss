import { Agent, Application, DecidedBy, Router, Workflow } from "../../../src/index.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import type { Class } from "../../../src/components/injection.js";
import { WorkflowStartTextDto } from "../../../src/dto/index.js";
import { testConfig, testDefaults } from "../../helpers.js";
import { route, start } from "../../helpers/flow.js";
import { NoAnswer, TestAnswer, TestChat } from "../../fixtures/test-flow/test.flow.js";
import { EmptyEnvironment } from "../../../src/index.js";

/** Prompts of one flow: the agent's (inline or files), the router's and its route's. */
export interface FlowPrompts {
  readonly agent?: { readonly prompt?: string; readonly promptUrls?: readonly string[] };
  readonly router?: string;
  readonly route?: string;
}

const price = testConfig.agents.alpha.price;

/** chat → router "main-router" → agent "scout-agent" → the answer. Variables: boards, boardCount. */
export function workflowWith(prompts: FlowPrompts): {
  workflow: Class;
  application: Class;
  router: Class;
  scout: Class;
} {
  @Agent({
    name: "scout-agent",
    description: "Scouts job boards",
    model: "test/alpha",
    price,
    ...(prompts.agent ?? { prompt: "You scout {{boards}}." }),
    promptVariables: { boardCount: "2" },
  })
  class Scout {}

  @Router({
    name: "main-router",
    description: "Sends the task to the scout, or ends",
    decidedBy: DecidedBy.Model,
    prompt: prompts.router ?? "Pick who handles it.",
    model: "typesafe/jev-1.13",
    input: { message: WorkflowStartTextDto },
    maxVisits: 4,
    routes: [
      { prompt: prompts.route ?? "Job boards to scout", target: Scout },
      { prompt: "Stop without an answer: nothing to scout", target: NoAnswer },
    ],
  })
  class Main {}

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
  class Prompts {}

  @Application({
    name: "prompts-application",
    version: "1.0.0",
    environment: EmptyEnvironment,
    workflows: [Prompts],
    budgets: TEST_BUDGETS,
  })
  class PromptsApplication {}

  return { workflow: Prompts, application: PromptsApplication, router: Main, scout: Scout };
}

/** A workflow whose router and route prompts use the workflow's variables. */
export const Templated = workflowWith({
  router: "Pick who handles it; the boards are {{boards}}.",
  route: "Scouting {{boards}}",
  agent: { promptUrls: ["./scout.prompt.md"] },
});
