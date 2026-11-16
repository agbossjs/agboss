import {
  ModelCost,
  ModelProvider,
  RetryPolicy,
  type ModelProviderHandler,
  type ModelProviderRequest,
  type ModelProviderResponse,
  type ModelProviderStream,
} from "../../../src/models/index.js";
import { minutes, seconds } from "../../../src/units/index.js";
import { bedrockApplicationOn, workflowsOn } from "../transport/bedrock-apps.fixture.js";
import { StreamSdkClient } from "./transport-streaming.fixture.js";

/** #1249: a transport that streams and has no price table: its provider says what each call cost. */
@ModelProvider({
  name: "stream-1249-model-provider",
  description: "A transport that streams and reports its cost",
  serves: [/^stream-c\//],
  timeout: seconds(5),
  cost: ModelCost.fromResponse(),
  retryPolicy: RetryPolicy.none(),
  circuitBreakerPolicy: { failureThreshold: 2, window: minutes(1), openFor: minutes(1) },
  deps: [StreamSdkClient],
})
export class StreamingCostModelProvider implements ModelProviderHandler {
  constructor(private readonly client: StreamSdkClient) {}

  complete(request: ModelProviderRequest): Promise<ModelProviderResponse> {
    return this.client.complete({
      model: request.model,
      toolCount: request.tools.length,
      signal: request.signal,
    });
  }

  stream(request: ModelProviderRequest): ModelProviderStream {
    return this.client.open({
      model: request.model,
      toolCount: request.tools.length,
      signal: request.signal,
    });
  }
}

export const STREAM_COST_DESK = workflowsOn("stream-c/model", "stream-1249");

export const TransportStreamCostApplication = bedrockApplicationOn({
  name: "stream-1249-application",
  desk: STREAM_COST_DESK,
  providers: [StreamingCostModelProvider, StreamSdkClient],
});
