import {
  DecisionsDriver,
  CircuitBreakerPolicy,
  ModelCost,
  ModelProvider,
  type ModelProviderDecisionRequest,
  type ModelProviderRequest,
  type ModelProviderResponse,
} from "../models/index.js";
import { minutes, seconds } from "../units/index.js";

/**
 * The model provider of a test application (#1328): `modelProvider: TestModelProvider` on its
 * `@Application` serves every model use of its workflows — chat agents, routers and judges on
 * `decide`, arbiters, and the default models of the levels. A test script (`mockLlm`, `replyWith`,
 * `routeTo`) answers every call before the provider is reached, so it never goes anywhere: a call
 * that gets through unscripted fails and says so. `/testing` makes no provider of its own — an
 * application that names none is `[model.missing-provider]`.
 */
@ModelProvider({
  name: "test-model-provider",
  description: "Serves the models of a test; the test's script answers every call",
  timeout: seconds(5),
  cost: ModelCost.fromResponse(),
  // a test may open it (`stores.rateLimits.pauseUntil(circuitOpenKeyOf("test-model-provider"), …)`)
  circuitBreakerPolicy: CircuitBreakerPolicy.fixed({
    failureThreshold: 5,
    failureWindow: minutes(1),
    openDuration: seconds(30),
  }),
  model: "test/model",
})
export class TestModelProvider {
  complete(request: ModelProviderRequest): Promise<ModelProviderResponse> {
    return Promise.reject(new Error(`a test called ${request.model} with no script for it`));
  }

  decide(request: ModelProviderDecisionRequest): Promise<unknown> {
    return Promise.reject(new Error(`a test decided on ${request.model} with no script for it`));
  }
}

/**
 * The provider of the components of a test that decide — a router, judge, arbiter, guardrail or
 * reply interpreter on a decision model (`modelProvider: TestDecisionsModelProvider` on the
 * component): a decision model has its own protocol, so no chat provider serves it. A test script
 * (`decideWith`, `routeTo`) answers before it is reached.
 */
@ModelProvider({
  name: "test-decisions-model-provider",
  description: "Serves the decision models of a test; the test's script answers every decision",
  driver: DecisionsDriver({ baseUrl: "http://decisions.test/v1" }),
  timeout: seconds(5),
  cost: ModelCost.fromResponse(),
  model: "test/decisions",
})
export class TestDecisionsModelProvider {}
