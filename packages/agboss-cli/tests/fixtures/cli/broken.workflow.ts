import { Agent, Application, inline, Ttl } from "../../../../agboss/src/index.js";
import { TEST_BUDGETS } from "../../../../agboss/tests/flow/fixtures/budgets.js";
import { Workflow } from "@agboss/core";
import { TestAnswer, TestChat } from "../../../../agboss/tests/fixtures/test-flow/test.flow.js";
import { onAgent, onStart } from "../../../../agboss/tests/helpers/flow.js";
import { TestModelProvider } from "../../../../agboss/src/testing/test-model-provider.js";

/**
 * The agents are this fixture's own: a class entered from one place only is underlined at that
 * place in the report (#1325c); the framework's test agents are entered from its own workflow too.
 */
@Agent({
  name: "researcher-agent",
  description: "Finds, explains and summarizes facts",
  model: "test/researcher",
  prompt: inline("Find facts."),
})
export class Researcher {}

@Agent({
  name: "coder-agent",
  description: "Writes, reviews and explains code",
  model: "test/coder",
  prompt: inline("Write code."),
})
export class Coder {}

/** `agboss check` fixture: the researcher leads nowhere (graph.dead-end), the coder is unreachable. */
@Workflow({
  name: "broken-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  defaults: {
    models: { temperature: 0, cache: true },
    router: { model: "typesafe/jev-1.13" },
    tools: { maxToolCalls: 2 },
  },
  flow: [
    onStart(TestChat)
      .toAgent(Researcher),
    onAgent(Coder)
      .toFinish(TestAnswer),
  ],
})
export class BrokenWorkflow {}

/** The application `agboss --application` loads (#268): this workflow alone. */
@Application({
  name: "broken-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  workflows: [BrokenWorkflow],
  budgets: TEST_BUDGETS,
})
export class BrokenApplication {}
