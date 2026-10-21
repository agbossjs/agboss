import { MODEL_MAX } from "../../../src/config/types.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import type { Class } from "../../../src/components/injection.js";
import type { ToolHandlerClass } from "../../../src/components/decorators.js";
import { WorkflowStartTextDto } from "../../../src/dto/index.js";
import { Agent } from "../../../src/flow/decorators/agent.js";
import { start } from "../../helpers/flow.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { TestAnswer, TestChat, testPaths } from "./test.flow.js";
import { EmptyEnvironment } from "../../../src/index.js";

/**
 * The star test workflow (tests/fixtures/test-flow): chat → main-router ("test/router", a chat
 * model scripted with `routeTo`) → alpha-agent / beta-agent → the answer; money: the test budgets.
 */
@Workflow({
  name: "test-bundle-workflow",
  version: "1.0.0",
  flow: testPaths,
  defaults: {
    models: { temperature: 0, maxTokens: MODEL_MAX, cache: true },
    tools: { maxToolCalls: 3 },
  },
  uncompactedTurns: 2,
})
export class StarWorkflow {}

@Application({
  name: "test-bundle-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [StarWorkflow],
  budgets: TEST_BUDGETS,
})
export class StarApplication {}

/** What `toolWorkflowOf` builds: alpha with its tools and limits. */
export interface ToolWorkflowOptions {
  readonly tools: readonly ToolHandlerClass[];
  readonly maxToolCalls?: number;
}

/**
 * chat → alpha-agent (with `tools`, a text agent) → the answer.
 * For the agent-loop tests: alpha's model is "test/alpha".
 */
export function toolWorkflowOf(options: ToolWorkflowOptions): Class {
  @Agent({
    name: "alpha-agent",
    description: "Handles alpha work with tools",
    prompt: "You are alpha.",
    model: "test/alpha",
    price: { inputPerMTok: 3, outputPerMTok: 6 },
    tools: options.tools,
    ...(options.maxToolCalls === undefined ? {} : { maxToolCalls: options.maxToolCalls }),
  })
  class ToolAlpha {}

  @Workflow({
    name: "tools-workflow",
    version: "1.0.0",
    flow: [
      start(TestChat)
        .returns(WorkflowStartTextDto)
        .toAgent(ToolAlpha)
        .toFinish(TestAnswer),
    ],
    defaults: {
      tools: { maxToolCalls: 3 },
      router: { model: "typesafe/jev-test" },
    },
    uncompactedTurns: 2,
  })
  class ToolWorkflow {}
  return ToolWorkflow;
}
