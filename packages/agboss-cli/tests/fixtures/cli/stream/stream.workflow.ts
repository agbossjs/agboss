// `agboss run "<task>"` fixture (#1005): one agent on the default OpenRouter provider, so a local
// model server at OPENROUTER_BASE_URL streams its answer to the terminal
import {
  Agent,
  Application,
  TokenLimit,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  inline,
  Ttl,
} from "../../../../../agboss/src/index.js";
import {
  WorkflowFinishTextDto,
  WorkflowStartTextDto,
} from "../../../../../agboss/src/dto/index.js";
import { TEST_BUDGETS } from "../../../../../agboss/tests/flow/fixtures/budgets.js";
import { onStart } from "../../../../../agboss/tests/helpers/flow.js";
import { StreamEnvironment } from "./environments/app.environment.js";
import { StreamModelProvider } from "../stream-model-provider.js";

@WorkflowStart({
  name: "ask-workflow-start",
  description: "A question",
  input: WorkflowStartTextDto,
})
export class AskWorkflowStart {}

@WorkflowFinish({
  name: "answer-workflow-finish",
  description: "The answer",
  output: WorkflowFinishTextDto,
})
export class AnswerWorkflowFinish {}

@Agent({
  name: "answering-agent",
  description: "Answers",
  prompt: inline("Answer the question."),
  model: "stream/model",
})
export class AnsweringAgent {}

@Workflow({
  name: "ask-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(AskWorkflowStart)
      .toAgent(AnsweringAgent)
      .toFinish(AnswerWorkflowFinish),
  ],
  defaults: { models: { temperature: 0, maxTokens: TokenLimit.ModelMax } },
})
export class AskWorkflow {}

@Application({
  modelProvider: StreamModelProvider,
  name: "stream-application",
  version: "1.0.0",
  environment: StreamEnvironment,
  workflows: [AskWorkflow],
  budgets: TEST_BUDGETS,
})
export class StreamApplication {}
