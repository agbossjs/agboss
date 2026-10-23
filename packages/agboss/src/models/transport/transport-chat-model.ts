import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import {
  BaseChatModel,
  type BindToolsInput,
  type LangSmithParams,
} from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { TokenLimit, type ResolvedModelSettings } from "../../config/types.js";
import { runModelCall, type ResilienceOptions } from "../calls/attempt-runner.js";
import type { PromptCaching } from "../prompt-caching.js";
import type { Reasoning } from "../reasoning.js";
import { aiMessageOf, providerMessagesOf, toolDefinitionsOf } from "./messages.js";
import { transportCarrier, type TransportCall } from "./transport-carrier.js";
import type { ModelProviderRequest, ModelProviderToolDefinition } from "./transport.js";

/** What a transport chat model is made of: its settings, the provider's policies and its `complete`. */
export interface TransportChatModelParts {
  readonly provider: string;
  readonly settings: ResolvedModelSettings;
  readonly reasoning: Reasoning;
  readonly promptCaching: PromptCaching;
  readonly resilience: ResilienceOptions;
  /** The provider's `complete`, its instance created (and started) by the container on first use. */
  readonly complete: () => Promise<TransportCall>;
}

/**
 * The chat model of a transport provider (#385): a `BaseChatModel` over its `complete(request)`,
 * so everything above the model — PII masking, answer tools, traces, budgets and the ledger,
 * `mockLlm` — works as for HTTP, and every call goes through the one attempt runner (retries, the
 * rate limit and its 429 pause, the breaker).
 */
export class TransportChatModel extends BaseChatModel {
  constructor(
    private readonly parts: TransportChatModelParts,
    private readonly tools: readonly ModelProviderToolDefinition[] = [],
  ) {
    super({});
  }

  _llmType(): string {
    return "agboss-transport";
  }

  /** The same model with the tools the caller bound (its own and its answer tools). */
  override bindTools(tools: BindToolsInput[]): TransportChatModel {
    return new TransportChatModel(this.parts, toolDefinitionsOf(tools));
  }

  override getLsParams(options: this["ParsedCallOptions"]): LangSmithParams {
    const { settings, provider } = this.parts;
    return {
      ...super.getLsParams(options),
      ls_provider: provider,
      ls_model_name: settings.model,
      ls_temperature: settings.temperature,
      ...(settings.maxTokens === TokenLimit.MODEL_MAX ? {} : { ls_max_tokens: settings.maxTokens }),
    };
  }

  /** The request `complete()` gets, but its signal (each attempt has its own). */
  private requestOf(messages: readonly BaseMessage[]): Omit<ModelProviderRequest, "signal"> {
    const { settings, provider, reasoning, promptCaching } = this.parts;
    return {
      model: settings.model,
      messages: providerMessagesOf(messages, provider),
      tools: this.tools,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens === TokenLimit.MODEL_MAX ? undefined : settings.maxTokens,
      reasoning,
      promptCaching,
    };
  }

  async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const { resilience, settings, provider } = this.parts;
    const carrier = transportCarrier(
      await this.parts.complete(),
      this.requestOf(messages),
      options.signal,
    );
    const response: unknown = await runModelCall(resilience, carrier, options.signal);
    const message = aiMessageOf(response, settings.model, provider);
    if (message.text !== "") await runManager?.handleLLMNewToken(message.text);
    return { generations: [{ text: message.text, message }] };
  }
}
