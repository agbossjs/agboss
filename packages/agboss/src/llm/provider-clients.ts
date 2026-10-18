import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ResolvedModelSettings } from "../config/types.js";
import type { Clock } from "../infrastructure/clock.js";
import type { CircuitBreakers } from "../models/circuit-breaker.js";
import { connectionOf } from "../models/connections.js";
import type { ProviderConnection } from "../models/handler.js";
import { ConfigurationError } from "../models/problems.js";
import type { ProviderFetch } from "../models/resilient-fetch.js";
import {
  ModelPurpose,
  type ModelProviderDirectory,
  type RegisteredModelProvider,
} from "../models/resolve.js";
import type { JevClient } from "./jev-client.js";
import type { ModelFactory } from "./registry.js";

/** What the production clients need: the environment, and the breakers and raw client for tests. */
export interface ProviderClientOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly breakers?: CircuitBreakers;
  readonly send?: ProviderFetch;
  /** The application's clock (timeouts, retry waits). Default: the system's. */
  readonly clock?: Clock;
}

export class ProviderCapabilityError extends Error {
  override name = "ProviderCapabilityError";
}

/**
 * The raw clients of the default gateway over model providers: the provider serving each model
 * makes its chat model or answers its decision. Every provider's key is read here, at startup.
 */
export function providerClients(
  directory: ModelProviderDirectory,
  options: ProviderClientOptions,
): { readonly chatModel: ModelFactory; readonly jevClient: JevClient } {
  const connections = new Map<string, ProviderConnection>(
    directory.providers.map((provider) => [
      provider.options.name,
      connectionOf(provider.options, { ...options, requireKeys: true }),
    ]),
  );
  const providerFor = (model: string, purpose: ModelPurpose) => {
    const resolution = directory.resolve({ key: model, model, purpose });
    if (resolution.kind === "problem") throw new ConfigurationError([resolution.problem]);
    const provider: RegisteredModelProvider = resolution.provider;
    const connection =
      connections.get(provider.options.name) ??
      connectionOf(provider.options, { ...options, requireKeys: true });
    return { provider, connection };
  };
  const chatModel = (settings: ResolvedModelSettings): BaseChatModel => {
    const { provider, connection } = providerFor(settings.model, ModelPurpose.Chat);
    const chat = provider.handler.chat?.bind(provider.handler);
    if (chat === undefined)
      throw new ProviderCapabilityError(`${provider.options.name} has no chat models`);
    return chat({
      settings,
      reasoning: settings.reasoning ?? provider.options.reasoning,
      promptCaching: settings.promptCaching ?? provider.options.promptCaching,
      connection,
    });
  };
  const jevClient: JevClient = (decision) => {
    const { provider, connection } = providerFor(decision.model, ModelPurpose.Decision);
    const routeTo = provider.handler.routeTo?.bind(provider.handler);
    if (routeTo === undefined)
      throw new ProviderCapabilityError(`${provider.options.name} does not routeTo`);
    return routeTo({ decision, connection });
  };
  return { chatModel, jevClient };
}
