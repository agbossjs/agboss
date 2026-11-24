import { fallbackHopsOf } from "../models/fallback-chain.js";
import { isFailoverError } from "../models/failover-error.js";
import type { ModelProviderType } from "../models/model-provider.decorator.js";
import type { RegisteredModelProvider } from "../models/resolve.js";
import type { ProviderConnection } from "../models/handler.js";
import type { JevDecisionRequest } from "./jev-client.js";
import { ProviderCapabilityError } from "./provider-chat-of.js";

/**
 * A decision call down its provider's fallback chain (#1313d, #1313c): the provider asked first; when
 * the call fails for the provider's own reasons (its breaker open, a timeout, a 429, a 5xx, a
 * refused credential — `isFailoverError`), the next provider of the chain is asked, for its mapped
 * model. A request the provider refused, or a caller's cancel, is the call's answer. Each provider
 * is asked once under its own price, timeout, retry and breaker; the answer is marked with who gave
 * it (`servedDecisionOf`), so the call is recorded under that provider. A provider that failed
 * without an answer billed nothing that is known.
 */

/** Who answered a decision: the provider's `name` and the model it was asked for. */
export interface DecisionServer {
  readonly provider: string;
  readonly model: string;
}

const served = new WeakMap<object, DecisionServer>();

/** Who answered `raw`, when a fallback did (the primary's answers are as they are). */
export const servedDecisionOf = (raw: unknown): DecisionServer | undefined =>
  typeof raw === "object" && raw !== null ? served.get(raw) : undefined;

/** One provider's way to answer a decision. */
export type DecideOn = (
  provider: RegisteredModelProvider,
  request: JevDecisionRequest,
) => Promise<unknown>;

/** A provider's `routeTo` over its connection: how one provider answers a decision. */
export const decideThrough =
  (connectionFor: (provider: RegisteredModelProvider) => ProviderConnection): DecideOn =>
  (provider, decision) => {
    const routeTo = provider.handler?.routeTo?.bind(provider.handler);
    if (routeTo === undefined)
      throw new ProviderCapabilityError(`${provider.options.name} does not routeTo`);
    return routeTo({ decision, connection: connectionFor(provider) });
  };

/** `request` asked of `primary`, then of each provider of its fallback chain, until one answers. */
export async function decideDownChain(
  primary: RegisteredModelProvider,
  request: JevDecisionRequest,
  parts: {
    readonly registeredFor: (cls: ModelProviderType) => RegisteredModelProvider;
    readonly decideOn: DecideOn;
    readonly signal?: AbortSignal | undefined;
  },
): Promise<unknown> {
  const hops = fallbackHopsOf(primary.type, request.model);
  try {
    return await parts.decideOn(primary, request);
  } catch (error) {
    if (hops.length === 0 || !isFailoverError(error, parts.signal)) throw error;
    return decideOnHops(hops, request, parts, error);
  }
}

async function decideOnHops(
  hops: ReturnType<typeof fallbackHopsOf>,
  request: JevDecisionRequest,
  parts: Parameters<typeof decideDownChain>[2],
  failure: unknown,
): Promise<unknown> {
  let last = failure;
  for (const hop of hops) {
    const asked = { ...request, model: hop.model };
    try {
      const raw = await parts.decideOn(parts.registeredFor(hop.cls as ModelProviderType), asked);
      if (typeof raw === "object" && raw !== null)
        served.set(raw, { provider: hop.options.name, model: hop.model });
      return raw;
    } catch (error) {
      last = error;
      if (!isFailoverError(error, parts.signal)) throw error;
    }
  }
  throw last;
}
