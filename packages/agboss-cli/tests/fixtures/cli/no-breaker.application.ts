import { CircuitBreakerPolicy } from "@agboss/core/models";
import { Application, EmptyEnvironment } from "../../../../agboss/src/index.js";
import {
  ModelCost,
  ModelProvider,
  OpenAiCompatibleDriver,
  PromptCaching,
  Reasoning,
  RetryPolicy,
} from "../../../../agboss/src/models/index.js";
import type { DriverModelProviderOptions } from "../../../../agboss/src/models/model-provider.decorator.js";
import { minutes, seconds } from "../../../../agboss/src/units/index.js";
import { TEST_BUDGETS } from "../../../../agboss/tests/flow/fixtures/budgets.js";
import { TestWorkflow } from "../../../../agboss/tests/fixtures/test-workflow/test.workflow.js";

export { TestWorkflow };

/**
 * `agboss check` fixture (#521 AC1): a JS project's provider — or a cast — without the
 * `circuitBreakerPolicy` its type requires.
 */
const complete: DriverModelProviderOptions = {
  name: "unguarded-model-provider",
  description: "Every model, with no breaker",
  driver: OpenAiCompatibleDriver({ baseUrl: "http://unguarded.test/v1" }),
  timeout: seconds(5),
  cost: ModelCost.fromResponse(),
  reasoning: Reasoning.modelDecides(),
  promptCaching: PromptCaching.off(),
  circuitBreakerPolicy: CircuitBreakerPolicy.fixed({
    failureThreshold: 3,
    failureWindow: minutes(1),
    openDuration: seconds(30),
  }),
};

const { circuitBreakerPolicy: _dropped, ...withoutBreaker } = complete;

@ModelProvider(withoutBreaker as DriverModelProviderOptions)
export class UnguardedModelProvider {}

/** The application `agboss --application` loads: the test workflow on that provider. */
@Application({
  modelProvider: UnguardedModelProvider,
  name: "no-breaker-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [TestWorkflow],
  providers: [UnguardedModelProvider],
  budgets: TEST_BUDGETS,
})
export class NoBreakerApplication {}
