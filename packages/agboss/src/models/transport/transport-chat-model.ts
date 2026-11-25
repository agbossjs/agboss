import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import {
  BaseChatModel,
  type BindToolsInput,
  type LangSmithParams,
} from "@langchain/core/language_models/chat_models";
import { AIMessage, AIMessageChunk, type BaseMessage } from "@langchain/core/messages";
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs";
import { TokenLimit, type ResolvedModelSettings } from "../../config/types.js";
import { runModelCall, type ResilienceOptions } from "../calls/attempt-runner.js";
import { systemClock } from "../../infrastructure/clock.js";
import type { PromptCaching } from "../prompt-caching.js";
import type { Reasoning } from "../reasoning.js";
import { aiMessageOf, providerMessagesOf, toolDefinitionsOf } from "./messages.js";
import { chunksOf } from "./transport-chunks.js";
import { transportCarrier, type TransportCall } from "./transport-carrier.js";
import { transportStreamCarrier, type TransportStreamCall } from "./transport-stream.js";
import type {
  ModelProviderRequest,
  ModelProviderResponse,
  ModelProviderToolDefinition,
} from "./transport.js";

/** What a transport chat model is made of: its settings, the provider's policies and its `complete`. */
export interface TransportChatModelParts {
  readonly provider: string;
  readonly settings: ResolvedModelSettings;
  readonly reasoning: Reasoning;
  readonly promptCaching: PromptCaching;
  readonly resilience: ResilienceOptions;
  /** The provider's calls, its instance created (and started) by the container on first use. */
  readonly calls: () => Promise<TransportCalls>;
}

/** What a transport provider can do: `complete`, and, when it has one, `stream` (#1011). */
export interface TransportCalls {
  readonly complete: TransportCall;
  readonly stream?: TransportStreamCall;
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
      ...(settings.maxTokens === TokenLimit.ModelMax ? {} : { ls_max_tokens: settings.maxTokens }),
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
      maxTokens: settings.maxTokens === TokenLimit.ModelMax ? undefined : settings.maxTokens,
      reasoning,
      promptCaching,
    };
  }

  /** A streamed call: its text goes out as it comes; the answer is the plain call's. */
  private async streamed(
    stream: TransportStreamCall,
    messages: readonly BaseMessage[],
    signal: AbortSignal | undefined,
    onText: (text: string) => Promise<void>,
  ): Promise<ModelProviderResponse> {
    const { resilience, provider } = this.parts;
    const limits = {
      provider,
      clock: resilience.clock ?? systemClock,
      timeout: resilience.timeout,
      breaker: resilience.breaker,
    };
    const carrier = transportStreamCarrier(stream, this.requestOf(messages), signal, limits);
    const answer = await runModelCall(resilience, carrier, signal);
    return await answer.consume(onText);
  }

  /** The answer of `complete(request)` through the attempt runner. */
  private async completed(
    messages: readonly BaseMessage[],
    signal: AbortSignal | undefined,
  ): Promise<AIMessage> {
    const { resilience, settings, provider } = this.parts;
    const { complete } = await this.parts.calls();
    const carrier = transportCarrier(complete, this.requestOf(messages), signal, provider);
    const response: unknown = await runModelCall(resilience, carrier, signal);
    return aiMessageOf(response, settings.model, provider);
  }

  async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const { settings, provider } = this.parts;
    const { stream } = await this.parts.calls();
    // a text stream carries no tool call: a call with tools bound is answered by `complete`
    if (stream !== undefined && this.tools.length === 0) {
      const response = await this.streamed(stream, messages, options.signal, async (text) => {
        if (text !== "") await runManager?.handleLLMNewToken(text);
      });
      const message = aiMessageOf(response, settings.model, provider);
      return { generations: [{ text: message.text, message }] };
    }
    const message = await this.completed(messages, options.signal);
    if (message.text !== "") await runManager?.handleLLMNewToken(message.text);
    return { generations: [{ text: message.text, message }] };
  }

  /** The message as a chunk with `content` as its text: its tool calls, usage, cost and finish reason. */
  private chunkOf(message: AIMessage, content: string): ChatGenerationChunk {
    const { tool_calls, usage_metadata, response_metadata } = message;
    const chunk = new AIMessageChunk({
      content,
      tool_calls,
      response_metadata,
      ...(usage_metadata === undefined ? {} : { usage_metadata }),
    });
    return new ChatGenerationChunk({ message: chunk, text: content });
  }

  /**
   * The call's text as it comes (#1311b), so a caller that streams the model (`model.stream`, a
   * fallback's `streamedAnswer`) hears each chunk live, not the whole answer at the end. A call with
   * tools bound is answered whole by `complete`, as `_generate` answers it. The last chunk carries
   * the usage, cost and finish reason, no text: the chunks add up to the answer.
   */
  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const { settings, provider } = this.parts;
    const { stream } = await this.parts.calls();
    if (stream === undefined || this.tools.length > 0) {
      const message = await this.completed(messages, options.signal);
      await runManager?.handleLLMNewToken(message.text);
      yield this.chunkOf(message, message.text);
      return;
    }
    const controller = new AbortController();
    const signal =
      options.signal === undefined
        ? controller.signal
        : AbortSignal.any([options.signal, controller.signal]);
    const reading = chunksOf(
      (onText) => this.streamed(stream, messages, signal, onText),
      () => {
        controller.abort();
      },
    );
    try {
      for await (const next of reading) {
        if (typeof next !== "string") {
          yield this.chunkOf(aiMessageOf(next, settings.model, provider), "");
        } else if (next !== "") {
          const chunk = new ChatGenerationChunk({
            message: new AIMessageChunk({ content: next }),
            text: next,
          });
          await runManager?.handleLLMNewToken(next, undefined, undefined, undefined, undefined, {
            chunk,
          });
          yield chunk;
        }
      }
    } finally {
      await reading.return(undefined);
    }
  }
}
