import {
  ModelCost,
  ModelProvider,
  ModelProviderMessageRole,
  RetryPolicy,
  type ModelProviderHandler,
  type ModelProviderRequest,
  type ModelProviderResponse,
} from "@agboss/core/models";
import { minutes, seconds, usd } from "@agboss/core/units";

const USAGE = { inputTokens: 1000, outputTokens: 100 };

/**
 * A transport model provider (#385) for the `harness/…` models: it answers by the request — no
 * network, no key — so `agboss eval run` and a real `agboss run` work at $0. The first call of a
 * visit looks the `#<id>` order up with `order-status-tool`; once the tool answered, it quotes it.
 * Scripted tests answer above it (`mockLlm`): `complete()` runs only outside them.
 */
@ModelProvider({
  name: "harness-model-provider",
  description: "Answers by the request, offline",
  serves: [/^harness\//],
  timeout: seconds(5),
  cost: ModelCost.fromPrices({
    "harness/desk": { inputPerMillion: usd(1), outputPerMillion: usd(1) },
  }),
  retryPolicy: RetryPolicy.none(),
  circuitBreakerPolicy: { failureThreshold: 5, window: minutes(1), openFor: seconds(30) },
})
export class HarnessModelProvider implements ModelProviderHandler {
  complete(request: ModelProviderRequest): Promise<ModelProviderResponse> {
    const result = request.messages.findLast(
      (message) => message.role === ModelProviderMessageRole.Tool,
    );
    if (result !== undefined)
      return Promise.resolve({ text: `It says: ${result.text}`, usage: USAGE });
    const asked = request.messages.map((message) => message.text).join("\n");
    const orderId = /#([\w-]+)/u.exec(asked)?.[1] ?? "unknown";
    return Promise.resolve({
      text: "",
      toolCalls: [{ id: "call-1", name: "order-status-tool", arguments: { orderId } }],
      usage: USAGE,
    });
  }
}
