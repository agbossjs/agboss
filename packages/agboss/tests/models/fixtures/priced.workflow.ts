import { file } from "../../../src/components/file.js";

import {
  Agent,
  Workflow,
  MODEL_MAX,
  WorkflowFinish,
  WorkflowStart,
  WorkflowSettings,
  type WorkflowDefinition,
} from "../../../src/index.js";
import { Text, WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../src/dto/index.js";
import { DecisionsModelProvider, Reasoning } from "../../../src/models/index.js";
import { start } from "../../helpers/flow.js";
import { usd } from "../../../src/units/index.js";
import { LocalModelProvider, TestOpenRouterProvider } from "../providers.fixture.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";

/** The summariser's summary: the writer reads it. */
export class SummaryDto {
  @Text({ prompt: "the summary" })
  text!: string;
}

/** Priced by its provider's table (local/llama), no price of its own. */
@Agent({
  name: "summariser-agent",
  promptUrls: ["./summariser.prompt.md"],
  description: "Summarises the task",
  model: "local/llama",
  input: { task: WorkflowStartTextDto },
  output: SummaryDto,
})
export class Summariser {}

/** Priced by its provider's replyWith (OpenRouter's usage.cost). */
@Agent({
  name: "writer-agent",
  promptUrls: ["./writer.prompt.md"],
  description: "Writes the replyWith",
  model: "moonshotai/kimi-k2.6",
  reasoning: Reasoning.off(),
  input: { summary: SummaryDto },
})
export class Writer {}

@WorkflowStart({ name: "task-workflow-start", description: "A task", input: WorkflowStartTextDto })
export class TaskStart {}

@WorkflowFinish({
  name: "answer-workflow-finish",
  description: "The answer",
  output: WorkflowFinishTextDto,
})
export class Answer {}

/** A straight line over two providers: a local server with a price table, and OpenRouter. */
@Workflow({
  name: "priced-workflow",
  version: "1.0.0",
  flow: [
    start(TaskStart)
      .returns(WorkflowStartTextDto)
      .toAgent(Summariser)
      .returns(SummaryDto)
      .toAgent(Writer)
      .toFinish(Answer),
  ],
  defaults: {
    models: { temperature: 0, maxTokens: MODEL_MAX },
    router: { model: "typesafe/jev-1.13" },
    tools: { maxToolCalls: 2 },
    history: { limit: 2 },
  },
})
export class Priced implements WorkflowDefinition {
  settings(): WorkflowSettings {
    return WorkflowSettings.builder()
      .limits({ perRun: { cost: usd(0.05) } })
      .modelProviders([TestOpenRouterProvider, DecisionsModelProvider, LocalModelProvider])
      .defaultModelProvider(LocalModelProvider)
      .build();
  }
}

@Application({
  name: "priced-application",
  version: "1.0.0",
  workflows: [Priced],
  budgets: TEST_BUDGETS,
})
export class PricedApplication {}
