import { ModelCost, ModelProvider, RetryPolicy } from "../../../src/models/index.js";
import { CircuitBreakerPolicy } from "../../../src/models/circuit-breaker-policy.js";
import { minutes, seconds, usd } from "../../../src/units/index.js";
import {
  Backup385ModelProvider,
  bedrockApplicationOn,
  workflowsOn,
} from "../transport/bedrock-apps.fixture.js";
import { StreamSdkClient, StreamingModelProvider } from "./transport-streaming.fixture.js";

/** #1311b: a transport that streams, its breaker's fallback an HTTP backup that streams too. */
@ModelProvider({
  name: "stream-fallback-1311-model-provider",
  description: "A transport that streams, with an HTTP backup",
  timeout: seconds(5),
  cost: ModelCost.fromPrices({
    "stream-f/model": { inputPerMillion: usd(1), outputPerMillion: usd(2) },
  }),
  circuitBreakerPolicy: CircuitBreakerPolicy.fixed({
    failureThreshold: 1,
    failureWindow: minutes(1),
    openDuration: minutes(1),
  }),
  fallback: { provider: Backup385ModelProvider, models: { "stream-f/model": "backup/claude" } },
  deps: [StreamSdkClient],
})
export class StreamingFallbackModelProvider extends StreamingModelProvider {}

export const TransportStreamFallbackApplication = bedrockApplicationOn({
  name: "stream-fallback-1311-application",
  desk: workflowsOn("stream-f/model", "stream-fallback-1311"),
  providers: [StreamingFallbackModelProvider, StreamSdkClient],
});
