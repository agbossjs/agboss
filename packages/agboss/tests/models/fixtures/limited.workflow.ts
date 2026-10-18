import { Agent, EmptyEnvironment, MODEL_MAX, Workflow } from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { WorkflowStartTextDto } from "../../../src/dto/index.js";
import {
  ModelCost,
  ModelFailure,
  ModelProvider,
  OpenAiCompatibleProvider,
  PromptCaching,
  QueueBalancingStrategy,
  RateLimitPolicy,
  Reasoning,
  RetryPolicy,
  type NoRequestFields,
} from "../../../src/models/index.js";
import { minutes, seconds, usd } from "../../../src/units/index.js";
import { ChatStart, Reply } from "../../channels/approval.workflow.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { start } from "../../helpers/flow.js";

/**
 * #266 AC3/AC4: a provider whose plan allows two calls in flight — one limit for the whole
 * application, every instance and tenant; a 429 is retried with backoff.
 */
@ModelProvider({
  name: "limited-model-provider",
  description: "A provider with a plan of two concurrent calls",
  serves: [/^limited\//],
  baseUrl: "http://limited.test/v1",
  timeout: seconds(30),
  cost: ModelCost.fromPrices({
    "limited/model": { inputPerMillion: usd(1), outputPerMillion: usd(2) },
  }),
  reasoning: Reasoning.modelDecides(),
  promptCaching: PromptCaching.off(),
  retryPolicy: RetryPolicy.exponential({
    maxAttempts: 3,
    initialDelay: seconds(1),
    maxDelay: seconds(10),
    jitter: false,
    retryOn: [ModelFailure.RateLimited],
  }),
  rateLimitPolicy: RateLimitPolicy.of({
    maxConcurrentCalls: 2,
    balancing: QueueBalancingStrategy.TenantRoundRobin,
  }),
  circuitBreakerPolicy: { failureThreshold: 100, window: minutes(1), openFor: seconds(1) },
})
export class LimitedModelProvider extends OpenAiCompatibleProvider {
  override readonly requestFields: NoRequestFields = {};
}

@Agent({
  name: "limited-agent",
  promptUrls: ["./limited.prompt.md"],
  description: "Answers on the limited provider",
  model: "limited/model",
})
export class LimitedAgent {}

@Workflow({
  name: "limited-workflow",
  version: "1.0.0",
  flow: [
    start(ChatStart)
      .returns(WorkflowStartTextDto)
      .toAgent(LimitedAgent)
      .toFinish(Reply),
  ],
  defaults: {
    models: { temperature: 0, maxTokens: MODEL_MAX },
    tools: { maxToolCalls: 1 },
    history: { limit: 1 },
  },
})
export class LimitedWorkflow {}

@Application({
  name: "limited-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [LimitedWorkflow],
  providers: [LimitedModelProvider],
  budgets: TEST_BUDGETS,
})
export class LimitedApplication {}
