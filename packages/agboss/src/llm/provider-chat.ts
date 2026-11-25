import { ConfigError } from "../core/error-families/config-errors.js";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ModelChaos } from "../eval/chaos/model-chaos.js";
import type { ResolvedModelSettings } from "../config/types.js";
import type { ProviderCalls } from "../models/calls/provider-calls.js";
import { resilienceOf } from "../models/connections.js";
import type { TransportResolver } from "../models/transport/transport-resolver.js";
import type { RegisteredModelProvider } from "../models/resolve.js";
import {
  TransportChatModel,
  type TransportCalls,
} from "../models/transport/transport-chat-model.js";
import type { Clock } from "../infrastructure/clock.js";

/**
 * The chat models of transport providers (#385) — loaded only by an application that has one
 * (`chatExtensionsFor`), so the root import stays small.
 */

/** What the extensions are made with: the instance's shared calls and clock, the container's instances. */
export interface ChatExtensionOptions {
  readonly calls?: ProviderCalls;
  /** Failures injected into `complete()` (#396 PR 6). */
  readonly chaos?: ModelChaos;
  readonly clock?: Clock;
  readonly transports?: TransportResolver;
}

/**
 * The transport's calls, its instance from the container on first use: `complete`, and its
 * `stream` when it has one — not under chaos (#396), which injects its failures into `complete`.
 */
async function callsOf(
  provider: RegisteredModelProvider,
  options: ChatExtensionOptions,
): Promise<TransportCalls> {
  const handler = provider.handler ?? (await options.transports?.started(provider.type));
  const complete = handler?.complete?.bind(handler);
  if (complete === undefined)
    throw new ConfigError.ModelProvider({
      message: `${provider.options.name}: a transport provider is created by the application's container — run it through createApp or testWith`,
    });
  if (options.chaos !== undefined) return { complete: options.chaos.completeOf(complete) };
  const stream = handler?.stream?.bind(handler);
  return stream === undefined ? { complete } : { complete, stream };
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
    calls: () => callsOf(provider, options),
  });
}
