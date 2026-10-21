import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { ChatOpenAI } from "@langchain/openai";
import { TokenLimit } from "../config/types.js";
import type { ModelCapabilities } from "./capabilities.js";
import type { ChatRequest, ModelProviderHandler, ProviderConnection } from "./handler.js";
import { ModelListCache, type ModelEntry } from "./model-list.js";
import { CacheRetention, type PromptCaching } from "./prompt-caching.js";
import type { Reasoning } from "./reasoning.js";
import { wireFetch, type CacheControl, type WireFields, type WirePlan } from "./wire.js";

/** No provider-specific request fields: only `{}` fits. */
export type NoRequestFields = Readonly<Record<string, never>>;

/** What a provider's caching plan is made from. */
export interface CachingRequest {
  readonly caching: PromptCaching;
  readonly model: string;
}

export const EPHEMERAL: CacheControl = { type: "ephemeral" };

/**
 * Any OpenAI-compatible server. `TFields` types the provider's own request fields: a subclass sets
 * `override readonly requestFields: TFields = { … }` and a typo there is a compile error. Reasoning
 * and caching are sent in OpenAI's form (`reasoning_effort`, `prompt_cache_key`,
 * `prompt_cache_retention`); a subclass with another dialect overrides `reasoningFields` / `cachingPlan`.
 */
export abstract class OpenAiCompatibleProvider<
  TFields extends object = NoRequestFields,
> implements ModelProviderHandler {
  abstract readonly requestFields: TFields;
  private readonly models = new ModelListCache();

  chat(request: ChatRequest): BaseChatModel {
    const { settings, connection } = request;
    return new ChatOpenAI({
      apiKey: connection.apiKey ?? "none",
      model: settings.model,
      temperature: settings.temperature,
      ...(settings.maxTokens === TokenLimit.MODEL_MAX ? {} : { maxTokens: settings.maxTokens }),
      // the provider's client owns timeouts and retries (its retry policy and circuit breaker)
      maxRetries: 0,
      configuration: {
        baseURL: connection.baseUrl,
        fetch: wireFetch(this.wirePlanOf(request), connection.fetch),
        defaultHeaders: { "X-Title": "AGBoss" },
      },
    });
  }

  /** Everything this provider adds to a request of `request`'s model. */
  wirePlanOf(request: Pick<ChatRequest, "settings" | "reasoning" | "promptCaching">): WirePlan {
    const caching = this.cachingPlan({
      caching: request.promptCaching,
      model: request.settings.model,
    });
    return {
      ...caching,
      fields: {
        ...this.wireFieldsOf(this.requestFields),
        ...this.reasoningFields(request.reasoning),
        ...caching.fields,
      },
    };
  }

  /** The provider's request fields as they go on the wire; a subclass may rename or reshape them. */
  protected wireFieldsOf(fields: TFields): WireFields {
    return Object.fromEntries(Object.entries(fields));
  }

  /** OpenAI's `reasoning_effort`; a budget is not part of OpenAI's API (the startup check says so). */
  protected reasoningFields(reasoning: Reasoning): WireFields {
    if (reasoning.kind === "off") return { reasoning_effort: "none" };
    if (reasoning.kind === "on" && reasoning.effort !== undefined) {
      return { reasoning_effort: reasoning.effort };
    }
    return {};
  }

  /** OpenAI caches automatically: a key routes requests to one cache, `24h` keeps it a day. */
  protected cachingPlan({ caching }: CachingRequest): WirePlan {
    if (caching.kind === "off") return { fields: {}, cacheMarkers: [], cacheControl: EPHEMERAL };
    return {
      fields: {
        ...(caching.key === undefined ? {} : { prompt_cache_key: caching.key }),
        ...(caching.retention === CacheRetention.OneDay ? { prompt_cache_retention: "24h" } : {}),
      },
      cacheMarkers: [],
      cacheControl: EPHEMERAL,
    };
  }

  async capabilities(
    model: string,
    connection: ProviderConnection,
  ): Promise<ModelCapabilities | undefined> {
    const entry = await this.models.entryOf(model, connection);
    return entry === undefined ? undefined : this.capabilitiesOf(entry);
  }

  /** A plain `/models` entry declares nothing beyond the model's existence. */
  protected capabilitiesOf(entry: ModelEntry): ModelCapabilities {
    return { model: entry.id };
  }
}
