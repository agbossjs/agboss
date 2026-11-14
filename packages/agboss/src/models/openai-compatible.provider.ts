import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { TokenLimit } from "../config/types.js";
import type { ChatOpenAI } from "@langchain/openai";
import { loadChatOpenAI, loadedChatOpenAI } from "./chat-openai.js";
import { LateModel, LazyChatModel } from "./lazy-chat-model.js";
import type { ModelCapabilities } from "./capabilities.js";
import type { ChatRequest, ModelProviderHandler, ProviderConnection } from "./handler.js";
import { ModelListCache, type ModelEntry } from "./model-list.js";
import { CacheRetention, type PromptCaching } from "./prompt-caching.js";
import type { Reasoning } from "./reasoning.js";
import { wireFetch, type CacheControl, type WirePlan } from "./wire.js";

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

  /**
   * The chat client. Inside an application it is the OpenAI client itself (assembly loads it, #956);
   * a `chat()` made before anything loaded it is a lazy model, the client's own on its first call.
   */
  chat(request: ChatRequest): BaseChatModel {
    const { settings, connection } = request;
    const clientOf = (Client: typeof ChatOpenAI): ChatOpenAI =>
      new Client({
        apiKey: connection.apiKey ?? "none",
        model: settings.model,
        temperature: settings.temperature,
        ...(settings.maxTokens === TokenLimit.MODEL_MAX ? {} : { maxTokens: settings.maxTokens }),
        // the provider's client owns timeouts and retries (its retry policy and circuit breaker)
        maxRetries: 0,
        // a streamed call (the run has `onStream`, #1005) reports its real usage, so budgets stay exact
        streamUsage: true,
        configuration: {
          baseURL: connection.baseUrl,
          fetch: this.responseFetch(wireFetch(this.wirePlanOf(request), connection.fetch)),
          defaultHeaders: { "X-Title": "AGBoss" },
        },
      });
    const loaded = loadedChatOpenAI();
    if (loaded !== undefined) return clientOf(loaded);
    return new LazyChatModel(new LateModel(async () => clientOf(await loadChatOpenAI())), {
      ls_provider: connection.provider,
      ls_model_type: "chat",
      ls_model_name: settings.model,
      ls_temperature: settings.temperature,
      ...(settings.maxTokens === TokenLimit.MODEL_MAX ? {} : { ls_max_tokens: settings.maxTokens }),
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

  /** The client's fetch as answers come back; a subclass may read more of them (OpenRouter's host). */
  protected responseFetch(send: typeof fetch): typeof fetch {
    return send;
  }

  /** The provider's request fields as they go on the wire; a subclass may rename or reshape them. */
  protected wireFieldsOf(fields: TFields): Readonly<Record<string, unknown>> {
    return Object.fromEntries(Object.entries(fields));
  }

  /** OpenAI's `reasoning_effort`; a budget is not part of OpenAI's API (the startup check says so). */
  protected reasoningFields(reasoning: Reasoning): Readonly<Record<string, unknown>> {
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
