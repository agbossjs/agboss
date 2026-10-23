import { Injectable, TenantContext } from "../../../src/index.js";
import type { Clock } from "../../../src/infrastructure/clock.js";
import {
  ModelCost,
  ModelProvider,
  QueueBalancingStrategy,
  RateLimitPolicy,
  RetryPolicy,
  TRANSIENT_FAILURES,
  type ModelProviderHandler,
  type ModelProviderMessage,
  type ModelProviderRequest,
  type ModelProviderResponse,
  type ModelProviderToolDefinition,
} from "../../../src/models/index.js";
import { minutes, seconds, usd } from "../../../src/units/index.js";

/**
 * #385: a transport provider as the issue's example has it — `complete(request)` over an SDK
 * client, the tenant from the injected `TenantContext` — and the SDK client a test scripts.
 */

/** What the SDK is asked: the request's model, messages, tools and signal, and the tenant. */
export interface BedrockInvocation {
  readonly model: string;
  readonly messages: readonly ModelProviderMessage[];
  readonly tools: readonly ModelProviderToolDefinition[];
  readonly tenantId: string;
  readonly signal: AbortSignal;
}

/** The SDK client; a test replaces it with a `ScriptedBedrockClient` (container overrides). */
@Injectable()
export class BedrockSdkClient {
  invoke(invocation: BedrockInvocation): Promise<ModelProviderResponse> {
    return Promise.reject(new Error(`BedrockSdkClient: no script for ${invocation.model}`));
  }
}

/** What one scripted call does: answer (by the invocation), or throw. */
export type BedrockReply =
  | ModelProviderResponse
  | Error
  | ((invocation: BedrockInvocation) => ModelProviderResponse | Promise<ModelProviderResponse>);

/** A recorded invocation and when it came, on the test's clock. */
export interface RecordedInvocation extends BedrockInvocation {
  readonly at: number;
}

/** Answers in order (the last repeats); every invocation recorded with the clock's time. */
export class ScriptedBedrockClient extends BedrockSdkClient {
  readonly invocations: RecordedInvocation[] = [];

  constructor(
    private readonly replies: readonly BedrockReply[],
    private readonly clock?: Clock,
  ) {
    super();
  }

  override invoke(invocation: BedrockInvocation): Promise<ModelProviderResponse> {
    const at = this.clock?.now().getTime() ?? 0;
    const reply = this.replies[Math.min(this.invocations.length, this.replies.length - 1)];
    this.invocations.push({ ...invocation, at });
    if (reply === undefined || reply instanceof Error)
      return Promise.reject(reply ?? new Error("none"));
    return Promise.resolve(typeof reply === "function" ? reply(invocation) : reply);
  }
}

/** A text answer: 1M input and 0.5M output tokens unless given. */
export const answer = (
  text: string,
  extra: Partial<ModelProviderResponse> = {},
): ModelProviderResponse => ({
  text,
  usage: { inputTokens: 1_000_000, outputTokens: 500_000 },
  ...extra,
});

@ModelProvider({
  name: "bedrock-model-provider",
  description: "AWS Bedrock through its SDK",
  serves: [/^bedrock\//],
  timeout: seconds(30),
  cost: ModelCost.fromPrices({
    "bedrock/claude": { inputPerMillion: usd(3), outputPerMillion: usd(15) },
  }),
  rateLimitPolicy: RateLimitPolicy.of({
    maxConcurrentCalls: 8,
    balancing: QueueBalancingStrategy.TenantRoundRobin,
  }),
  retryPolicy: RetryPolicy.exponential({
    maxAttempts: 3,
    initialDelay: seconds(1),
    maxDelay: seconds(20),
    jitter: false,
    retryOn: TRANSIENT_FAILURES,
  }),
  circuitBreakerPolicy: { failureThreshold: 5, window: minutes(1), openFor: seconds(30) },
  deps: [BedrockSdkClient, TenantContext],
})
export class BedrockModelProvider implements ModelProviderHandler {
  constructor(
    private readonly bedrockSdkClient: BedrockSdkClient,
    private readonly tenantContext: TenantContext,
  ) {}

  async complete(request: ModelProviderRequest): Promise<ModelProviderResponse> {
    return this.bedrockSdkClient.invoke({
      model: request.model,
      messages: request.messages,
      tools: request.tools,
      tenantId: this.tenantContext.tenantId,
      signal: request.signal,
    });
  }
}
