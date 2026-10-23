import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { ResolvedModelSettings } from "../config/types.js";
import { connectionOf } from "../models/connections.js";
import type { ProviderConnection } from "../models/handler.js";
import { isTransportClass, type ModelProviderType } from "../models/model-provider.decorator.js";
import {
  registeredOf,
  type ModelProviderDirectory,
  type RegisteredModelProvider,
} from "../models/resolve.js";
import type { ChatExtensions, ProviderClientOptions } from "./provider-clients.js";
import type { ChatOf } from "./provider-fallback.js";

export class ProviderCapabilityError extends Error {
  override name = "ProviderCapabilityError";
}

/** Each provider's connection, made once (its key read at the first). */
export function connectionsOf(
  options: ProviderClientOptions,
): (provider: RegisteredModelProvider) => ProviderConnection {
  const connections = new Map<string, ProviderConnection>();
  return (provider) => {
    const made =
      connections.get(provider.options.name) ??
      connectionOf(provider.options, { ...options, requireKeys: true });
    connections.set(provider.options.name, made);
    return made;
  };
}

/** A provider class as registered: the directory's own entry, else registered once (a fallback). */
export function registeredIn(
  directory: ModelProviderDirectory,
): (cls: ModelProviderType) => RegisteredModelProvider {
  const registered = new Map(directory.providers.map((provider) => [provider.type, provider]));
  return (cls) => {
    const known = registered.get(cls) ?? registeredOf(cls);
    registered.set(cls, known);
    return known;
  };
}

/** What chat models are made with: the clients' options, the connections, the transports' models. */
export interface ChatParts {
  readonly options: ProviderClientOptions;
  readonly connectionFor: (provider: RegisteredModelProvider) => ProviderConnection;
  readonly extensions?: ChatExtensions;
}

/** A provider's chat model for settings: its `chat` over its connection, or a transport's (#385). */
export function chatOfProviders(parts: ChatParts): ChatOf {
  const { options, connectionFor, extensions } = parts;
  return (provider: RegisteredModelProvider, settings: ResolvedModelSettings): BaseChatModel => {
    if (provider.handler === undefined || isTransportClass(provider.type)) {
      if (extensions === undefined)
        throw new ProviderCapabilityError(
          `${provider.options.name}: its chat models are not loaded (chatExtensionsFor)`,
        );
      return extensions.transportChatOf(provider, settings, options);
    }
    const chat = provider.handler.chat?.bind(provider.handler);
    if (chat === undefined)
      throw new ProviderCapabilityError(`${provider.options.name} has no chat models`);
    return chat({
      settings,
      reasoning: settings.reasoning ?? provider.options.reasoning,
      promptCaching: settings.promptCaching ?? provider.options.promptCaching,
      connection: connectionFor(provider),
    });
  };
}
