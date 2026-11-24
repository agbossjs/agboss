import {
  ModelCost,
  ModelProvider,
  type ModelProviderRequest,
  type ModelProviderResponse,
} from "../../../models/index.js";
import { minutes, seconds } from "../../../units/index.js";
import { CircuitBreakerPolicy } from "../../../models/circuit-breaker-policy.js";

/**
 * The fault fixture's only model provider (#484): its workflows call no model, so it is never
 * called. Listed so that no provider with a key is needed: a pod runs offline.
 */
@ModelProvider({
  name: "fault-model-provider",
  description: "Serves no model: the fault fixture calls none",
  timeout: seconds(5),
  cost: ModelCost.fromResponse(),
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
