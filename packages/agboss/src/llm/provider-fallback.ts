import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ResolvedModelSettings } from "../config/types.js";
import type { ProviderCalls } from "../models/calls/provider-calls.js";
import { FallbackChatModel } from "../models/fallback-chat-model.js";
import type { RegisteredModelProvider } from "../models/resolve.js";

/** A chat model of a provider for settings (its `chat`, else its `complete`). */
export type ChatOf = (
  provider: RegisteredModelProvider,
  settings: ResolvedModelSettings,
) => BaseChatModel;

/** What a primary's fallback is made of: both providers, the call's settings, the shared calls. */
export interface FallbackParts {
  readonly provider: RegisteredModelProvider;
  readonly fallback: RegisteredModelProvider;
  readonly settings: ResolvedModelSettings;
  readonly calls: ProviderCalls;
  readonly chatOf: ChatOf;
}

/**
 * The primary's chat model with its breaker's fallback (#202): the fallback provider's chat model
 * for its mapped model (`fallbackModels`), HTTP or a transport either way round.
 */
export function withFallback(primary: BaseChatModel, parts: FallbackParts): BaseChatModel {
  const { provider, fallback, settings, calls, chatOf } = parts;
  const policy = provider.options.circuitBreakerPolicy;
  const model = policy.fallbackModels?.[settings.model] ?? settings.model;
  return new FallbackChatModel({
    primary,
    breaker: calls.breakerOf(provider.options.name, policy),
    fallback: {
      chatModel: () => chatOf(fallback, { ...settings, model, price: undefined }),
      model,
      cost: fallback.options.cost,
    },
  });
}
