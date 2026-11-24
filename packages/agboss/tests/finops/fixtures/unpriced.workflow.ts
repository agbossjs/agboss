import { Window1Memory } from "../../helpers/window-memory.js";
import {
  Agent,
  EmptyEnvironment,
  TokenLimit,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  inline,
} from "../../../src/index.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../src/dto/index.js";
import { Application } from "../../../src/application/application.js";
import { ModelCost, ModelProvider, OpenAiCompatibleDriver } from "../../../src/models/index.js";
import { seconds } from "../../../src/units/index.js";
import { onStart } from "../../helpers/flow.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";

/** No cost, no retryPolicy, no circuitBreakerPolicy: a local or subscription provider. */
@ModelProvider({
  driver: OpenAiCompatibleDriver({ baseUrl: "http://free.test/v1" }),
  model: "local/model",
  timeout: seconds(5),
})
export class FreeModels {}

@ModelProvider({
  driver: OpenAiCompatibleDriver({ baseUrl: "http://paid.test/v1" }),
  model: "paid/model",
  timeout: seconds(5),
  cost: ModelCost.fromResponse(),
})
export class PricedModels {}

@Agent({
  name: "free-agent",
  prompt: inline("Answer."),
  description: "On the free provider",
  modelProvider: FreeModels,
})
export class FreeAgent {}

@Agent({
  name: "paid-agent",
  prompt: inline("Answer."),
  description: "On the paid provider",
  modelProvider: PricedModels,
})
export class PaidAgent {}

@WorkflowStart({
  name: "unpriced-workflow-start",
  description: "A message",
  input: WorkflowStartTextDto,
})
export class UnpricedStart {}

@WorkflowFinish({
  name: "unpriced-workflow-finish",
  description: "The answer",
  output: WorkflowFinishTextDto,
})
export class UnpricedFinish {}

@WorkflowStart({
  name: "paid-workflow-start",
  description: "A message",
  input: WorkflowStartTextDto,
})
export class PaidStart {}

@WorkflowFinish({
  name: "paid-workflow-finish",
  description: "The answer",
  output: WorkflowFinishTextDto,
})
export class PaidFinish {}

const defaults = { models: { temperature: 0, maxTokens: TokenLimit.ModelMax } };

@Workflow({
  name: "unpriced-workflow",
  version: "1.0.0",
  flow: [
    onStart(UnpricedStart)
      .toAgent(FreeAgent)
      .toFinish(UnpricedFinish),
  ],
  defaults,
  memory: Window1Memory,
})
export class UnpricedWorkflow {}

@Workflow({
  name: "paid-workflow",
  version: "1.0.0",
  flow: [
    onStart(PaidStart)
      .toAgent(PaidAgent)
      .toFinish(PaidFinish),
  ],
  defaults,
  memory: Window1Memory,
})
export class PaidWorkflow {}

@Application({
  name: "unpriced-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [UnpricedWorkflow, PaidWorkflow],
  budgets: TEST_BUDGETS,
})
export class UnpricedApplication {}
