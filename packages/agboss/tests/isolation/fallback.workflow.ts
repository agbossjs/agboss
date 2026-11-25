import { TestDecisionsProvider } from "../models/providers.fixture.js";
import { Window1Memory } from "../helpers/window-memory.js";
import { Agent, Workflow, TokenLimit, Ttl } from "../../src/index.js";
import {
  ModelCost,
  ModelProvider,
  OpenAiCompatibleDriver,
  PromptCaching,
  Reasoning,
  RetryPolicy,
} from "../../src/models/index.js";
import { minutes, seconds, usd } from "../../src/units/index.js";
import { ChatStart, Reply } from "../channels/approval.workflow.js";
import { onStart } from "../helpers/flow.js";
import { Application } from "../../src/application/application.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { EmptyEnvironment } from "../../src/index.js";
import { CircuitBreakerPolicy } from "../../src/models/circuit-breaker-policy.js";

/** One failed call opens a breaker for a minute (names of their own: breaker state is per name). */
const breaker = CircuitBreakerPolicy.fixed({
  failureThreshold: 1,
  failureWindow: minutes(1),
  openDuration: minutes(1),
});

const common = {
  timeout: seconds(5),
  reasoning: Reasoning.modelDecides(),
  promptCaching: PromptCaching.off(),
};

/** The fallback: its own model and its own, higher prices. */
@ModelProvider({
  ...common,
  name: "backup-202-model-provider",
  description: "The backup server",
  driver: OpenAiCompatibleDriver({ baseUrl: "http://backup-202.test/v1" }),
  cost: ModelCost.fromPrices({
    "backup/model": { inputPerMillion: usd(10), outputPerMillion: usd(20) },
  }),
  circuitBreakerPolicy: breaker,
})
export class Backup202 {}

const primary = {
  ...common,
  description: "The primary server",
  driver: OpenAiCompatibleDriver({ baseUrl: "http://primary-202.test/v1" }),
  cost: ModelCost.fromPrices({
    "primary/model": { inputPerMillion: usd(1), outputPerMillion: usd(2) },
  }),
};

/** Falls back to the backup with `primary/model` mapped to `backup/model`. */
@ModelProvider({
  ...primary,
  name: "primary-202-model-provider",
  circuitBreakerPolicy: breaker,
  fallback: { provider: Backup202, models: { "primary/model": "backup/model" } },
})
export class Primary202 {}

/** Falls back to the backup without saying which of its models takes over. */
@ModelProvider({
  ...primary,
  name: "unmapped-202-model-provider",
  circuitBreakerPolicy: breaker,
  fallback: Backup202,
})
export class Unmapped202 {}

@Agent({
  name: "cashier-agent",
  prompt: "./cashier.prompt.md",
  description: "Answers",
  model: "primary/model",
})
export class Answerer {}

const defaults = {
  models: { temperature: 0, maxTokens: TokenLimit.ModelMax },
  tools: { maxToolCalls: 1 },
} as const;

@Workflow({
  name: "fallback-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(ChatStart)
    .toAgent(Answerer)
    .toFinish(Reply)],
  defaults,
  memory: Window1Memory,
})
export class WithFallback {}

@Application({
  name: "fallback-application",
  modelProvider: Primary202,
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [WithFallback],
  providers: [Primary202, TestDecisionsProvider, Backup202],
  budgets: TEST_BUDGETS,
})
export class WithFallbackApplication {}

@Workflow({
  name: "unmapped-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(ChatStart)
    .toAgent(Answerer)
    .toFinish(Reply)],
  defaults,
  memory: Window1Memory,
})
export class UnmappedFallback {}

@Application({
  name: "unmapped-application",
  modelProvider: Unmapped202,
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [UnmappedFallback],
  providers: [Unmapped202, TestDecisionsProvider, Backup202],
  budgets: TEST_BUDGETS,
})
export class UnmappedFallbackApplication {}
