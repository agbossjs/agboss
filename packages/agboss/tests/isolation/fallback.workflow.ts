import { Agent, Workflow, MODEL_MAX } from "../../src/index.js";
import {
  DecisionsModelProvider,
  ModelCost,
  ModelProvider,
  OpenAiCompatibleProvider,
  PromptCaching,
  Reasoning,
  RetryPolicy,
  type NoRequestFields,
} from "../../src/models/index.js";
import { minutes, seconds, usd } from "../../src/units/index.js";
import { ChatStart, Reply } from "../channels/approval.workflow.js";
import { start } from "../helpers/flow.js";
import { WorkflowStartTextDto } from "../../src/dto/index.js";
import { Application } from "../../src/application/application.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { EmptyEnvironment } from "../../src/index.js";

/** One failed call opens a breaker for a minute (names of their own: breaker state is per name). */
const breaker = { failureThreshold: 1, window: minutes(1), openFor: minutes(1) };

const common = {
  timeout: seconds(5),
  reasoning: Reasoning.modelDecides(),
  promptCaching: PromptCaching.off(),
  retryPolicy: RetryPolicy.none(),
};

/** The fallback: its own model and its own, higher prices. */
@ModelProvider({
  ...common,
  name: "backup-202-model-provider",
  description: "The backup server",
  serves: [/^backup\//],
  baseUrl: "http://backup-202.test/v1",
  cost: ModelCost.fromPrices({
    "backup/model": { inputPerMillion: usd(10), outputPerMillion: usd(20) },
  }),
  circuitBreakerPolicy: breaker,
})
export class Backup202 extends OpenAiCompatibleProvider {
  override readonly requestFields: NoRequestFields = {};
}

const primary = {
  ...common,
  description: "The primary server",
  serves: [/^primary\//],
  baseUrl: "http://primary-202.test/v1",
  cost: ModelCost.fromPrices({
    "primary/model": { inputPerMillion: usd(1), outputPerMillion: usd(2) },
  }),
};

/** Falls back to the backup with `primary/model` mapped to `backup/model`. */
@ModelProvider({
  ...primary,
  name: "primary-202-model-provider",
  circuitBreakerPolicy: {
    ...breaker,
    fallback: Backup202,
    fallbackModels: { "primary/model": "backup/model" },
  },
})
export class Primary202 extends OpenAiCompatibleProvider {
  override readonly requestFields: NoRequestFields = {};
}

/** Falls back to the backup without saying which of its models takes over. */
@ModelProvider({
  ...primary,
  name: "unmapped-202-model-provider",
  circuitBreakerPolicy: { ...breaker, fallback: Backup202 },
})
export class Unmapped202 extends OpenAiCompatibleProvider {
  override readonly requestFields: NoRequestFields = {};
}

@Agent({
  name: "cashier-agent",
  promptUrls: ["./cashier.prompt.md"],
  description: "Answers",
  model: "primary/model",
})
export class Answerer {}

const defaults = {
  models: { temperature: 0, maxTokens: MODEL_MAX },
  router: { model: "typesafe/jev-1.13" },
  tools: { maxToolCalls: 1 },
  history: { limit: 1 },
} as const;

@Workflow({
  name: "fallback-workflow",
  version: "1.0.0",
  flow: [
    start(ChatStart)
      .returns(WorkflowStartTextDto)
      .toAgent(Answerer)
      .toFinish(Reply),
  ],
  defaults,
})
export class WithFallback {}

@Application({
  name: "fallback-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [WithFallback],
  providers: [Primary202, DecisionsModelProvider, Backup202],
  budgets: TEST_BUDGETS,
})
export class WithFallbackApplication {}

@Workflow({
  name: "unmapped-workflow",
  version: "1.0.0",
  flow: [
    start(ChatStart)
      .returns(WorkflowStartTextDto)
      .toAgent(Answerer)
      .toFinish(Reply),
  ],
  defaults,
})
export class UnmappedFallback {}

@Application({
  name: "unmapped-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [UnmappedFallback],
  providers: [Unmapped202, DecisionsModelProvider, Backup202],
  budgets: TEST_BUDGETS,
})
export class UnmappedFallbackApplication {}
