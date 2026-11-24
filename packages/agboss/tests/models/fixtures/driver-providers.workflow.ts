import { Window1Memory } from "../../helpers/window-memory.js";
import {
  Agent,
  EmptyEnvironment,
  TokenLimit,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
} from "../../../src/index.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../src/dto/index.js";
import { Application } from "../../../src/application/application.js";
import { env } from "../../../src/environments/env-readers.js";
import { secret } from "../../../src/environments/secret.js";
import {
  CircuitBreakerPolicy,
  DecisionsDriver,
  ModelCost,
  ModelProvider,
  OpenAiCompatibleDriver,
  OpenRouterDriver,
  RetryPolicy,
} from "../../../src/models/index.js";
import { minutes, seconds } from "../../../src/units/index.js";
import { onStart } from "../../helpers/flow.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";

const breaker = { failureThreshold: 3, window: minutes(1), openFor: seconds(30) };
const common = {
  timeout: seconds(5),
  cost: ModelCost.fromResponse(),
  retryPolicy: RetryPolicy.none(),
  circuitBreakerPolicy: breaker,
};

/** A chat provider whose roles map to the vendor's names. */
@ModelProvider({
  ...common,
  driver: OpenAiCompatibleDriver({
    baseUrl: env("LLM_URL"),
    apiKey: secret("LLM_KEY"),
    headers: { "x-tenant": "acme", "x-token": secret("LLM_TOKEN") },
  }),
  models: { default: "vendor/big", fast: "vendor/small" },
})
export class AppChatModels {}

/** A second chat provider with a single `model`, no roles. */
@ModelProvider({
  ...common,
  driver: OpenRouterDriver({ apiKey: secret("OR_KEY") }),
  model: "router/only",
})
export class SingleModelProvider {}

/** A provider with neither `model` nor `models`. */
@ModelProvider({
  ...common,
  driver: OpenAiCompatibleDriver({ baseUrl: "http://bare.test/v1" }),
})
export class BareChatModels {}

/** A decisions provider. */
@ModelProvider({
  ...common,
  driver: DecisionsDriver({ baseUrl: "http://decide.test/v1", knownModels: ["decide/one"] }),
  model: "decide/one",
})
export class DecisionModels {}

@Agent({ name: "fast-agent", prompt: "Answer.", description: "Answers fast", model: "fast" })
export class FastAgent {}

@Agent({ name: "plain-agent", prompt: "Answer.", description: "Names no model" })
export class PlainAgent {}

@Agent({
  name: "own-agent",
  prompt: "Answer.",
  description: "Names its own provider",
  modelProvider: SingleModelProvider,
})
export class OwnAgent {}

@Agent({
  name: "literal-agent",
  prompt: "Answer.",
  description: "Names a vendor model as written",
  model: "vendor/literal",
})
export class LiteralAgent {}

@WorkflowStart({
  name: "fast-workflow-start",
  description: "A message",
  input: WorkflowStartTextDto,
})
export class FastStart {}

@WorkflowFinish({
  name: "fast-workflow-finish",
  description: "The answer",
  output: WorkflowFinishTextDto,
})
export class FastFinish {}

@WorkflowStart({
  name: "plain-workflow-start",
  description: "A message",
  input: WorkflowStartTextDto,
})
export class PlainStart {}

@WorkflowFinish({
  name: "plain-workflow-finish",
  description: "The answer",
  output: WorkflowFinishTextDto,
})
export class PlainFinish {}

@WorkflowStart({
  name: "own-workflow-start",
  description: "A message",
  input: WorkflowStartTextDto,
})
export class OwnStart {}

@WorkflowFinish({
  name: "own-workflow-finish",
  description: "The answer",
  output: WorkflowFinishTextDto,
})
export class OwnFinish {}

@WorkflowStart({
  name: "literal-workflow-start",
  description: "A message",
  input: WorkflowStartTextDto,
})
export class LiteralStart {}

@WorkflowFinish({
  name: "literal-workflow-finish",
  description: "The answer",
  output: WorkflowFinishTextDto,
})
export class LiteralFinish {}

@WorkflowStart({
  name: "bare-workflow-start",
  description: "A message",
  input: WorkflowStartTextDto,
})
export class BareStart {}

@WorkflowFinish({
  name: "bare-workflow-finish",
  description: "The answer",
  output: WorkflowFinishTextDto,
})
export class BareFinish {}

@WorkflowStart({
  name: "nop-workflow-start",
  description: "A message",
  input: WorkflowStartTextDto,
})
export class NopStart {}

@WorkflowFinish({
  name: "nop-workflow-finish",
  description: "The answer",
  output: WorkflowFinishTextDto,
})
export class NopFinish {}

@WorkflowStart({
  name: "dec-workflow-start",
  description: "A message",
  input: WorkflowStartTextDto,
})
export class DecStart {}

@WorkflowFinish({
  name: "dec-workflow-finish",
  description: "The answer",
  output: WorkflowFinishTextDto,
})
export class DecFinish {}

const defaults = { models: { temperature: 0, maxTokens: TokenLimit.ModelMax } };

@Workflow({
  name: "fast-workflow",
  version: "1.0.0",
  flow: [onStart(FastStart)
    .toAgent(FastAgent)
    .toFinish(FastFinish)],
  defaults,
  memory: Window1Memory,
})
export class FastWorkflow {}

@Workflow({
  name: "plain-workflow",
  version: "1.0.0",
  flow: [onStart(PlainStart)
    .toAgent(PlainAgent)
    .toFinish(PlainFinish)],
  defaults,
  memory: Window1Memory,
})
export class PlainWorkflow {}

@Workflow({
  name: "own-workflow",
  version: "1.0.0",
  flow: [onStart(OwnStart)
    .toAgent(OwnAgent)
    .toFinish(OwnFinish)],
  defaults,
  memory: Window1Memory,
})
export class OwnWorkflow {}

@Workflow({
  name: "literal-workflow",
  version: "1.0.0",
  flow: [onStart(LiteralStart)
    .toAgent(LiteralAgent)
    .toFinish(LiteralFinish)],
  defaults,
  memory: Window1Memory,
})
export class LiteralWorkflow {}

/** The application names the provider; the workflow and the agents inherit it. */
@Application({
  name: "drivers-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [FastWorkflow, PlainWorkflow, OwnWorkflow, LiteralWorkflow],
  modelProvider: AppChatModels,
  providers: [AppChatModels, SingleModelProvider],
  budgets: TEST_BUDGETS,
})
export class DriversApplication {}

/** Only the application's provider is named: it is not listed, and still part of the application. */
@Application({
  name: "unlisted-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [FastWorkflow, OwnWorkflow],
  modelProvider: AppChatModels,
  budgets: TEST_BUDGETS,
})
export class UnlistedApplication {}

@Workflow({
  name: "bare-workflow",
  version: "1.0.0",
  flow: [onStart(BareStart)
    .toAgent(PlainAgent)
    .toFinish(BareFinish)],
  defaults,
  memory: Window1Memory,
  modelProvider: BareChatModels,
})
export class BareWorkflow {}

/** An agent that names no model, on a provider that has none: `[model.missing]`. */
@Application({
  name: "bare-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [BareWorkflow],
  budgets: TEST_BUDGETS,
})
export class BareApplication {}

@Workflow({
  name: "no-provider-workflow",
  version: "1.0.0",
  flow: [onStart(NopStart)
    .toAgent(FastAgent)
    .toFinish(NopFinish)],
  defaults,
  memory: Window1Memory,
})
export class NoProviderWorkflow {}

/** A driver provider is listed, no cascade names one: `[model.missing-provider]`. */
@Application({
  name: "no-provider-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [NoProviderWorkflow],
  providers: [AppChatModels],
  budgets: TEST_BUDGETS,
})
export class NoProviderApplication {}

@Workflow({
  name: "decision-provider-workflow",
  version: "1.0.0",
  flow: [onStart(DecStart)
    .toAgent(LiteralAgent)
    .toFinish(DecFinish)],
  defaults,
  memory: Window1Memory,
  modelProvider: DecisionModels,
})
export class DecisionProviderWorkflow {}

/** A chat agent on a provider with a decisions driver: `[model.incompatible-provider]`. */
@Application({
  name: "decision-provider-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [DecisionProviderWorkflow],
  budgets: TEST_BUDGETS,
})
export class DecisionProviderApplication {}
