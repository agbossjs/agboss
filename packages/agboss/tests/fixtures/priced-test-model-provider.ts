import {
  CircuitBreakerPolicy,
  ModelCost,
  ModelProvider,
  type ModelPrice,
  type ModelProviderDecisionRequest,
  type ModelProviderRequest,
  type ModelProviderResponse,
} from "../../src/models/index.js";
import { minutes, seconds, usd } from "../../src/units/index.js";

/** The price of the models the unit tests script: $3 in, $6 out per million tokens. */
const SCRIPTED: ModelPrice = { inputPerMillion: usd(3), outputPerMillion: usd(6) };

/** The price of the researcher and the coder of the test workflow: $0.5 in, $3 out, $0.1 cached. */
const CHEAP: ModelPrice = {
  inputPerMillion: usd(0.5),
  outputPerMillion: usd(3),
  cacheReadPerMillion: usd(0.1),
};

/**
 * A test provider with a price table, for the tests whose spend is tokens × a price (the agent's
 * price moved to its provider, #1313): each model the tests script is priced at `SCRIPTED`.
 */
@ModelProvider({
  name: "priced-test-model-provider",
  description:
    "Serves the models of a unit test at a price table; the test's script answers every call",
  timeout: seconds(5),
  cost: ModelCost.fromPrices({
    "test/alpha": SCRIPTED,
    "test/beta": SCRIPTED,
    "test/router": SCRIPTED,
    "test/researcher": CHEAP,
    "test/reviewer": SCRIPTED,
    "test/editor": SCRIPTED,
    "test/writer": SCRIPTED,
    "test/coder": CHEAP,
    "test/model": SCRIPTED,
    "typesafe/jev-1.13": SCRIPTED,
  }),
  circuitBreakerPolicy: CircuitBreakerPolicy.fixed({
    failureThreshold: 5,
    failureWindow: minutes(1),
    openDuration: seconds(30),
  }),
  model: "test/model",
})
export class PricedTestModelProvider {
  complete(request: ModelProviderRequest): Promise<ModelProviderResponse> {
    return Promise.reject(new Error(`a test called ${request.model} with no script for it`));
  }

  decide(request: ModelProviderDecisionRequest): Promise<unknown> {
    return Promise.reject(new Error(`a test decided on ${request.model} with no script for it`));
  }
}
