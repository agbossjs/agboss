import { Application, EmptyEnvironment } from "../../../../agboss/src/index.js";
import {
  ModelCost,
  ModelProvider,
  OpenAiCompatibleProvider,
  PromptCaching,
  Reasoning,
  RetryPolicy,
  type NoRequestFields,
} from "../../../../agboss/src/models/index.js";
import type { HttpModelProviderOptions } from "../../../../agboss/src/models/model-provider.decorator.js";
import { minutes, seconds } from "../../../../agboss/src/units/index.js";
import { TEST_BUDGETS } from "../../../../agboss/tests/flow/fixtures/budgets.js";
import { TestWorkflow } from "../../../../agboss/tests/fixtures/test-workflow/test.workflow.js";

/**
 * `agboss check` fixture (#521 AC1): a JS project's provider — or a cast — without the
 * `circuitBreakerPolicy` its type requires.
 */
const complete: HttpModelProviderOptions = {
  name: "unguarded-model-provider",
  description: "Every model, with no breaker",
  serves: [/.*/],
  baseUrl: "http://unguarded.test/v1",
  timeout: seconds(5),
  cost: ModelCost.fromResponse(),
  reasoning: Reasoning.modelDecides(),
  promptCaching: PromptCaching.off(),
  retryPolicy: RetryPolicy.none(),
  circuitBreakerPolicy: { failureThreshold: 3, window: minutes(1), openFor: seconds(30) },
};

const { circuitBreakerPolicy: _dropped, ...withoutBreaker } = complete;

@ModelProvider(withoutBreaker as HttpModelProviderOptions)
export class UnguardedModelProvider extends OpenAiCompatibleProvider {
  override readonly requestFields: NoRequestFields = {};
}

/** The application `agboss --application` loads: the test workflow on that provider. */
@Application({
  name: "no-breaker-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [TestWorkflow],
  providers: [UnguardedModelProvider],
  budgets: TEST_BUDGETS,
})
export class NoBreakerApplication {}
