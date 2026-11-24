import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ResolvedModelSettings } from "../config/types.js";
import type { ProviderCalls } from "../models/calls/provider-calls.js";
import { FallbackChatModel } from "../models/fallback-chat-model.js";
import { fallbackHopsOf } from "../models/fallback-chain.js";
import type { ModelProviderType } from "../models/model-provider.decorator.js";
import type { RegisteredModelProvider } from "../models/resolve.js";
import { reportFrameEvent } from "../flow/observers/execution-event.js";
import { ModelFallbackReason } from "../flow/observers/model-fallback.js";
import { observedFailureOf } from "../flow/observers/failure.js";

/** A chat model of a provider for settings (its `chat`, else its `complete`). */
export type ChatOf = (
  provider: RegisteredModelProvider,
  settings: ResolvedModelSettings,
) => BaseChatModel;

/** What a primary's fallback chain is made of: the provider, the call's settings, the shared calls. */
export interface FallbackParts {
  readonly provider: RegisteredModelProvider;
  /** The registered provider of each class of the chain. */
  readonly registeredFor: (cls: ModelProviderType) => RegisteredModelProvider;
  readonly settings: ResolvedModelSettings;
  readonly calls: ProviderCalls | undefined;
  readonly chatOf: ChatOf;
}

/**
 * The primary's chat model with its provider's fallback chain (#202, #1313): each hop is the next
 * provider's chat model for its mapped model, re-resolving what the primary's provider defaulted
 * (reasoning, prompt caching) from the hop's own options, priced by the hop's own prices; its answer
 * is marked so the call is recorded under that provider, never the primary's.
 */
export function withFallback(primary: BaseChatModel, parts: FallbackParts): BaseChatModel {
  const { provider, registeredFor, settings, calls, chatOf } = parts;
  const policy = provider.options.circuitBreakerPolicy;
  const hops = fallbackHopsOf(provider.type, settings.model).map((hop) => {
    const registered = registeredFor(hop.cls as ModelProviderType);
    return {
      chatModel: () =>
        chatOf(registered, {
          ...settings,
          model: hop.model,
          price: undefined,
          modelProvider: hop.options.name,
          unpriced: hop.options.cost === undefined ? true : undefined,
        }),
      model: hop.model,
      cost: hop.options.cost,
      provider: hop.options.name,
    };
  });
  const told = (hop: (typeof hops)[number], after: unknown): Promise<void> =>
    reportFrameEvent((observer, base) =>
      observer.onModelFallback({
        ...base,
        primaryProvider: provider.options.name,
        primaryModel: settings.model,
        fallbackProvider: hop.provider,
        fallbackModel: hop.model,
        reason: after === undefined ? ModelFallbackReason.CircuitOpen : ModelFallbackReason.Failed,
        error: after === undefined ? undefined : observedFailureOf(after),
        caller: base.step.component.name,
      }),
    );
  return new FallbackChatModel({
    primary,
    onHop: told,
    ...(calls === undefined || policy === undefined
      ? {}
      : { breaker: calls.breakerOf(provider.options.name, policy) }),
    hops,
  });
}
