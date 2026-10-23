import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ResolvedModelSettings } from "../config/types.js";
import type { ProviderCalls } from "../models/calls/provider-calls.js";
import { resilienceOf } from "../models/connections.js";
import type { ModelProviderHandler } from "../models/handler.js";
import { ModelProviderError, type ModelProviderType } from "../models/model-provider.decorator.js";
import type { RegisteredModelProvider } from "../models/resolve.js";
import { TransportChatModel } from "../models/transport/transport-chat-model.js";
import type { TransportCall } from "../models/transport/transport-carrier.js";
import type { Clock } from "../infrastructure/clock.js";

/**
 * The chat models of transport providers (#385) — loaded only by an application that has one
 * (`chatExtensionsFor`), so the root import stays small.
 */

/** The instance of a transport provider class: the application's container creates it (one per application). */
export type TransportResolver = (cls: ModelProviderType) => ModelProviderHandler;

/** What the extensions are made with: the instance's shared calls and clock, the container's instances. */
export interface ChatExtensionOptions {
  readonly calls?: ProviderCalls;
  readonly clock?: Clock;
  readonly transports?: TransportResolver;
}

/** The transport's `complete`, its instance from the container on first use. */
function completeOf(
  provider: RegisteredModelProvider,
  options: ChatExtensionOptions,
): TransportCall {
  const handler = provider.handler ?? options.transports?.(provider.type);
  const complete = handler?.complete?.bind(handler);
  if (complete === undefined)
    throw new ModelProviderError(
      `${provider.options.name}: a transport provider is created by the application's container — run it through createApp or testWith`,
    );
  return complete;
}

/** A transport provider's chat model for one set of settings. */
export function transportChatOf(
  provider: RegisteredModelProvider,
  settings: ResolvedModelSettings,
  options: ChatExtensionOptions,
): BaseChatModel {
  return new TransportChatModel({
    provider: provider.options.name,
    settings,
    reasoning: settings.reasoning ?? provider.options.reasoning,
    promptCaching: settings.promptCaching ?? provider.options.promptCaching,
    resilience: resilienceOf(provider.options, options),
    complete: () => completeOf(provider, options),
  });
}
