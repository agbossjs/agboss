import { Window2Memory } from "../../helpers/window-memory.js";
import { TokenLimit } from "../../../src/config/types.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import type { Class } from "../../../src/components/injection.js";
import type { ToolHandlerClass } from "../../../src/components/decorators.js";
import { Agent } from "../../../src/flow/decorators/agent.js";
import { onStart } from "../../helpers/flow.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { TestAnswer, TestChat, testPaths } from "./test.flow.js";
import { EmptyEnvironment, inline, Ttl } from "../../../src/index.js";
import { TestModelProvider } from "../../../src/testing/test-model-provider.js";

/**
 * The star test workflow (tests/fixtures/test-flow): chat → main-router ("test/router", a chat
 * model scripted with `routeTo`) → alpha-agent / beta-agent → the answer; money: the test budgets.
 */
@Workflow({
  name: "test-bundle-workflow",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: testPaths,
  defaults: {
    models: { temperature: 0, maxTokens: TokenLimit.ModelMax, cache: true },
    tools: { maxToolCalls: 3 },
  },
  memory: Window2Memory,
})
export class StarWorkflow {}

@Application({
  name: "test-bundle-application",
  modelProvider: TestModelProvider,
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
    prompt: inline("You are alpha."),
    model: "test/alpha",
    price: { inputPerMTok: 3, outputPerMTok: 6 },
    tools: options.tools,
    ...(options.maxToolCalls === undefined
      ? {}
      : { executionLimits: { maxToolCalls: options.maxToolCalls } }),
  })
  class ToolAlpha {}

  @Workflow({
    name: "tools-workflow",
    modelProvider: TestModelProvider,
    version: "1.0.0",
    historyTtl: Ttl.Forever,
    flow: [
      onStart(TestChat)
        .toAgent(ToolAlpha)
        .toFinish(TestAnswer),
    ],
    defaults: {
      tools: { maxToolCalls: 3 },
      router: { model: "typesafe/jev-test" },
    },
    memory: Window2Memory,
  })
  class ToolWorkflow {}
  return ToolWorkflow;
}
