import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ResolvedModelSettings } from "../config/types.js";
import type { Environment } from "../flow/generated-types.js";
import type { Clock } from "../infrastructure/clock.js";
import type { ProviderCalls } from "../models/calls/provider-calls.js";
import { isModelProviderClass, isTransportClass } from "../models/model-provider.decorator.js";
import { ConfigurationError } from "../models/problems.js";
import type { ProviderFetch } from "../models/resilient-fetch.js";
import type { ModelChaos } from "../eval/chaos/model-chaos.js";
import {
  ModelPurpose,
  type ModelProviderDirectory,
  type RegisteredModelProvider,
} from "../models/resolve.js";
import type { JevClient } from "./jev-client.js";
import type * as ProviderChat from "./provider-chat.js";
import type { TransportResolver } from "../models/transport/transport-resolver.js";
import type { ModelFactory } from "./registry.js";
import { withFallback } from "./provider-fallback.js";
import {
  chatOfProviders,
  connectionsOf,
  ProviderCapabilityError,
  registeredIn,
} from "./provider-chat-of.js";
import { withFallbacks } from "../models/resolution.js";

export { ProviderCapabilityError } from "./provider-chat-of.js";

/**
 * What the production clients need: the process environment (base URLs), the application's
 * environment (keys), the instance's shared calls (rate limits, 429 pauses, breakers), the
 * application's container for transport providers (#385) and, in tests, a raw client.
 */
export interface ProviderClientOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly environment: Environment;
  /** Absent: no rate limit and no breaker (a recording). */
  readonly calls?: ProviderCalls;
  readonly send?: ProviderFetch;
  /** Chaos injected into transport providers' `complete()` too (#396 PR 6). */
  readonly chaos?: ModelChaos;
  /** The application's clock (timeouts, retry waits). Default: the system's. */
  readonly clock?: Clock;
  /** Creates a transport provider's instance (the application's container), on its first call. */
  readonly transports?: TransportResolver;
}

/** The chat models of transport providers (#385), loaded only when an application has one. */
export type ChatExtensions = Pick<typeof ProviderChat, "transportChatOf">;

/** The extensions, loaded when a provider or a breaker's fallback is a transport (#385: lazily). */
export async function chatExtensionsFor(
  directory: ModelProviderDirectory,
): Promise<ChatExtensions | undefined> {
  const classes = withFallbacks(directory.providers.map((provider) => provider.type));
  return classes.some(isTransportClass) ? import("./provider-chat.js") : undefined;
}

/**
 * The raw clients of the default gateway over model providers: the provider serving each model
 * makes its chat model (`chat`, or a transport's `complete`, #385) or answers its decision; a
 * breaker's fallback wraps the chat model. Every HTTP provider's key is read here, at startup, from
 * the application's environment.
 */
export function providerClients(
  directory: ModelProviderDirectory,
  options: ProviderClientOptions,
  extensions?: ChatExtensions,
): { readonly chatModel: ModelFactory; readonly jevClient: JevClient } {
  const connectionFor = connectionsOf(options);
  directory.providers.forEach(connectionFor);
  const registeredFor = registeredIn(directory);
  const chatOf = chatOfProviders({
    options,
    connectionFor,
    ...(extensions === undefined ? {} : { extensions }),
  });
  const providerFor = (model: string, purpose: ModelPurpose): RegisteredModelProvider => {
    const resolution = directory.resolve({ key: model, model, purpose });
    if (resolution.kind === "problem") throw new ConfigurationError([resolution.problem]);
    return resolution.provider;
  };
  const chatModel = (settings: ResolvedModelSettings): BaseChatModel => {
    const provider = providerFor(settings.model, ModelPurpose.Chat);
    const primary = chatOf(provider, settings);
    const fallback = provider.options.circuitBreakerPolicy.fallback;
    if (!isModelProviderClass(fallback) || options.calls === undefined) return primary;
    return withFallback(primary, {
      provider,
      fallback: registeredFor(fallback),
      settings,
      calls: options.calls,
      chatOf,
    });
  };
  const jevClient: JevClient = (decision) => {
    const provider = providerFor(decision.model, ModelPurpose.Decision);
    const routeTo = provider.handler?.routeTo?.bind(provider.handler);
    if (routeTo === undefined)
      throw new ProviderCapabilityError(`${provider.options.name} does not routeTo`);
    return routeTo({ decision, connection: connectionFor(provider) });
  };
  return { chatModel, jevClient };
}
