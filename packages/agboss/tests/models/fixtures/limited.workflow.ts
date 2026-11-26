import { Window1Memory } from "../../helpers/window-memory.js";
import { Agent, TokenLimit, Workflow, Ttl } from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import {
  ModelCost,
  ModelFailure,
  ModelProvider,
  OpenAiCompatibleDriver,
  PromptCaching,
  QueueBalancingStrategy,
  RateLimitPolicy,
  Reasoning,
  RetryPolicy,
} from "../../../src/models/index.js";
import { minutes, seconds, usd } from "../../../src/units/index.js";
import { ChatStart, Reply } from "../../channels/approval.workflow.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { onStart } from "../../helpers/flow.js";
import { CircuitBreakerPolicy } from "../../../src/models/circuit-breaker-policy.js";

/**
 * #266 AC3/AC4: a provider whose plan allows two calls in flight — one limit for the whole
 * application, every instance and tenant; a 429 is retried with backoff.
 */
@ModelProvider({
  name: "limited-model-provider",
  description: "A provider with a plan of two concurrent calls",
  driver: OpenAiCompatibleDriver({ baseUrl: "http://limited.test/v1" }),
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
  circuitBreakerPolicy: CircuitBreakerPolicy.fixed({
    failureThreshold: 100,
    failureWindow: minutes(1),
    openDuration: seconds(1),
  }),
})
export class LimitedModelProvider {}

@Agent({
  name: "limited-agent",
  prompt: "./limited.prompt.md",
  description: "Answers on the limited provider",
  model: "limited/model",
})
export class LimitedAgent {}

@Workflow({
  name: "limited-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(ChatStart).toAgent(LimitedAgent).toFinish(Reply)],
  defaults: {
    models: { temperature: 0, maxTokens: TokenLimit.ModelMax },
    tools: { maxToolCalls: 1 },
  },
  memory: Window1Memory,
})
export class LimitedWorkflow {}

@Application({
  name: "limited-application",
  version: "1.0.0",
  workflows: [LimitedWorkflow],
  providers: [LimitedModelProvider],
  modelProvider: LimitedModelProvider,
  budgets: TEST_BUDGETS,
})
export class LimitedApplication {}
