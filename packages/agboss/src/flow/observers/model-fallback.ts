import type { NodeEvent } from "./execution-event.js";
import type { ObservedFailure } from "./failure.js";

/** Why a call went to a fallback provider. */
export enum ModelFallbackReason {
  /** The primary's circuit breaker was open: its calls are not tried. */
  CircuitOpen = "circuit-open",
  /** The primary's call failed for the provider's own reasons, after its retries. */
  Failed = "failed",
}

/**
 * A model call moved down its provider's fallback chain (#202, `onModelFallback`): once per hop the
 * call tries, before the fallback is asked. Told in the step the call is made for — an agent's model
 * call or another component's (a judge, a router, an arbiter, a guardrail); a call made outside any
 * step is not told. Providers and models are names; the failure is its class and code, never its text.
 */
export interface ModelFallbackEvent extends Partial<NodeEvent> {
  /** The `@ModelProvider` the call was made for. */
  readonly primaryProvider: string;
  readonly primaryModel: string;
  /** The provider the call goes to now. */
  readonly fallbackProvider: string;
  readonly fallbackModel: string;
  readonly reason: ModelFallbackReason;
  /** What the provider before it failed with; `undefined` for `CircuitOpen` of the primary. */
  readonly error: ObservedFailure | undefined;
  /** Who asked: the name of the component whose step the call is made in. */
  readonly caller: string;
}
