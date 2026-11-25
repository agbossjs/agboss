import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ResolvedModelSettings } from "../config/types.js";
import type { Environment } from "../flow/generated-types.js";
import type { Clock } from "../infrastructure/clock.js";
import type { ProviderCalls } from "../models/calls/provider-calls.js";
import {
  fallbackOf,
  isDriverOptions,
  isTransportClass,
} from "../models/model-provider.decorator.js";
import { ConfigurationError } from "../models/problems.js";
import type { ProviderFetch } from "../models/resilient-fetch.js";
import type { ModelChaos } from "../eval/chaos/model-chaos.js";
import { ModelKind } from "../models/model-kind.js";
import { type ModelProviderDirectory, type RegisteredModelProvider } from "../models/resolve.js";
import type { JevClient } from "./jev-client.js";
import type * as ProviderChat from "./provider-chat.js";
import type { TransportResolver } from "../models/transport/transport-resolver.js";
import type { ModelFactory } from "./registry.js";
import { decideDownChain, decideThrough } from "./decisions-failover.js";
import { withFallback } from "./provider-fallback.js";
import { chatOfProviders, connectionsOf, registeredIn } from "./provider-chat-of.js";
import { loadChatOpenAI } from "../models/chat-openai.js";
import { withFallbacks } from "../models/resolution.js";
import { lazyLoad } from "../infrastructure/clock.js";
import { modelPricingOf } from "../models/workflow-models.js";
import type { ModelPricing } from "../models/model-pricing.js";

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
  /**
   * The providers connected — their keys read — at start (#716): those a model use of the workflow
   * resolves to, and their breakers' fallbacks. Absent → every provider of the directory. Any other
   * connects on its first call, so a provider that serves no model of the application needs no key.
   */
  readonly connectAtStart?: readonly RegisteredModelProvider[];
}

/** The chat models of transport providers (#385), loaded only when an application has one. */
export type ChatExtensions = Pick<typeof ProviderChat, "transportChatOf">;

/** The extensions, loaded when a provider or a breaker's fallback is a transport (#385: lazily). */
export async function chatExtensionsFor(
  directory: ModelProviderDirectory,
): Promise<ChatExtensions | undefined> {
  const classes = withFallbacks(directory.providers.map((provider) => provider.type));
  // the HTTP providers' `chat` is synchronous: their client is loaded here, at assembly (#956)
  if (!classes.every(isTransportClass)) await loadChatOpenAI();
  return classes.some(isTransportClass) ? lazyLoad(import("./provider-chat.js")) : undefined;
}

/**
 * The raw clients of the default gateway over model providers: the provider serving each model
 * makes its chat model (`chat`, or a transport's `complete`, #385) or answers its decision; a
 * breaker's fallback wraps the chat model. The key of every HTTP provider a model use needs is read
 * here, at startup, from the application's environment (`connectAtStart`, #716); another's on its
 * first call.
 */
export function providerClients(
  directory: ModelProviderDirectory,
  options: ProviderClientOptions,
  extensions?: ChatExtensions,
): {
  readonly chatModel: ModelFactory;
  readonly jevClient: JevClient;
  readonly kindOf: (modelProvider: string | undefined) => ModelKind | undefined;
  readonly pricing: ModelPricing;
} {
  const connectionFor = connectionsOf(options);
  const registeredFor = registeredIn(directory);
  (options.connectAtStart ?? directory.providers).forEach(connectionFor);
  const chatOf = chatOfProviders({
    options,
    connectionFor,
    ...(extensions === undefined ? {} : { extensions }),
  });
  const providerFor = (
    model: string,
    purpose: ModelKind,
    modelProvider?: string,
  ): RegisteredModelProvider => {
    const resolution = directory.resolve({ key: model, model, purpose, modelProvider });
    if (resolution.kind === "problem")
      throw new ConfigurationError({ problems: [resolution.problem] });
    return resolution.provider;
  };
  const chatModel = (settings: ResolvedModelSettings): BaseChatModel => {
    const provider = providerFor(settings.model, ModelKind.Chat, settings.modelProvider);
    const primary = chatOf(provider, settings);
    // no shared calls (a recording): no breaker, but the chain still answers a failed call
    if (fallbackOf(provider.options) === undefined) return primary;
    return withFallback(primary, {
      provider,
      registeredFor,
      settings,
      calls: options.calls,
      chatOf,
    });
  };
  const jevClient: JevClient = (decision, modelProvider) =>
    decideDownChain(providerFor(decision.model, ModelKind.Decisions, modelProvider), decision, {
      registeredFor,
      decideOn: decideThrough(connectionFor),
    });
  return { chatModel, jevClient, kindOf: kindOfIn(directory), pricing: modelPricingOf(directory) };
}

/**
 * What a model is, by the driver of the provider its cascade resolved (#1313); `undefined` when no
 * provider is named or its driver is an older provider's — the caller's name patterns then decide.
 */
const kindOfIn =
  (directory: ModelProviderDirectory) =>
  (modelProvider: string | undefined): ModelKind | undefined =>
    directory.providers.flatMap((provider) =>
      provider.options.name === modelProvider && isDriverOptions(provider.options)
        ? [provider.options.driver.kind]
        : [],
    )[0];
