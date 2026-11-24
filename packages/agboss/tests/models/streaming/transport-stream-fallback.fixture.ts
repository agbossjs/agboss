import { ModelCost, ModelProvider, RetryPolicy } from "../../../src/models/index.js";
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
  serves: [/^stream-f\//],
  timeout: seconds(5),
  cost: ModelCost.fromPrices({
    "stream-f/model": { inputPerMillion: usd(1), outputPerMillion: usd(2) },
  }),
  retryPolicy: RetryPolicy.none(),
  circuitBreakerPolicy: {
    failureThreshold: 1,
    window: minutes(1),
    openFor: minutes(1),
    fallback: Backup385ModelProvider,
    fallbackModels: { "stream-f/model": "backup/claude" },
  },
  deps: [StreamSdkClient],
})
export class StreamingFallbackModelProvider extends StreamingModelProvider {}

export const TransportStreamFallbackApplication = bedrockApplicationOn({
  name: "stream-fallback-1311-application",
  desk: workflowsOn("stream-f/model", "stream-fallback-1311"),
  providers: [StreamingFallbackModelProvider, StreamSdkClient],
});
