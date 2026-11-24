import {
  ModelCost,
  ModelProvider,
  RetryPolicy,
  type ModelProviderRequest,
  type ModelProviderResponse,
} from "../../../models/index.js";
import { minutes, seconds } from "../../../units/index.js";
import { CircuitBreakerPolicy } from "../../../models/circuit-breaker-policy.js";

/**
 * The fault fixture's only model provider (#484): its workflows call no model, so it serves no
 * model a component names (`fault/…`) and is never called. Listed so the built-in OpenRouter
 * providers, which need a key, are not: a pod runs offline.
 */
@ModelProvider({
  name: "fault-model-provider",
  description: "Serves no model: the fault fixture calls none",
  serves: [/^fault\//u],
  timeout: seconds(5),
  cost: ModelCost.fromResponse(),
  retryPolicy: RetryPolicy.none(),
  circuitBreakerPolicy: CircuitBreakerPolicy.fixed({
    failureThreshold: 5,
    failureWindow: minutes(1),
    openDuration: seconds(10),
  }),
})
export class FaultModelProvider {
  complete(request: ModelProviderRequest): Promise<ModelProviderResponse> {
    return Promise.reject(new Error(`the fault fixture calls no model (${request.model})`));
  }
}
