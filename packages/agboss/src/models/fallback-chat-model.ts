import { BaseChatModel, type BindToolsInput } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { ModelCallError, type CircuitBreaker } from "./circuit-breaker.js";
import type { ModelCost } from "./cost.js";
import { markedFallbackMessage } from "./fallback.js";
import { ModelProviderError } from "./model-provider.decorator.js";

/** Where calls go while the primary's breaker is open: its chat model, the model, its prices. */
export interface FallbackTarget {
  readonly chatModel: () => BaseChatModel;
  /** The fallback's model for the primary's (`circuitBreakerPolicy.fallbackModels`). */
  readonly model: string;
  readonly cost: ModelCost;
}

/** What a primary chat model with a fallback is made of. */
export interface FallbackChatModelParts {
  readonly primary: BaseChatModel;
  readonly breaker: CircuitBreaker;
  readonly fallback: FallbackTarget;
}

/** Whether a call failed because the breaker opened (the error, or one of its causes). */
function isCircuitOpen(error: unknown): boolean {
  for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) {
    if (cause instanceof ModelCallError) return true;
  }
  return false;
}

/**
 * A provider's chat model with its breaker's fallback (#202, at the chat model since #385 — so
 * HTTP and transport providers fall back to each other either way): while the primary's breaker
 * is open, the call goes to the fallback provider's chat model as its mapped model, and its answer
 * is marked so it is accounted under that model and the fallback's prices.
 */
export class FallbackChatModel extends BaseChatModel {
  constructor(
    private readonly parts: FallbackChatModelParts,
    private readonly tools: readonly BindToolsInput[] = [],
  ) {
    super({});
  }

  _llmType(): string {
    return "agboss-fallback";
  }

  override bindTools(tools: BindToolsInput[]): FallbackChatModel {
    return new FallbackChatModel(this.parts, tools);
  }

  /** One call of a chat model with the bound tools; untraced: this model's run is the call's. */
  private async callOf(
    model: BaseChatModel,
    messages: BaseMessage[],
    signal?: AbortSignal,
  ): Promise<BaseMessage> {
    const bound = this.tools.length === 0 ? model : model.bindTools?.([...this.tools]);
    if (bound === undefined)
      throw new ModelProviderError("the fallback's chat model cannot call tools");
    return bound.invoke(messages, { callbacks: [], ...(signal === undefined ? {} : { signal }) });
  }

  private async viaFallback(messages: BaseMessage[], signal?: AbortSignal): Promise<BaseMessage> {
    const { fallback } = this.parts;
    const answer = await this.callOf(fallback.chatModel(), messages, signal);
    return markedFallbackMessage(answer, fallback.model, fallback.cost);
  }

  private async answerOf(messages: BaseMessage[], signal?: AbortSignal): Promise<BaseMessage> {
    if (await this.parts.breaker.isOpen()) return this.viaFallback(messages, signal);
    try {
      return await this.callOf(this.parts.primary, messages, signal);
    } catch (error) {
      if (isCircuitOpen(error)) return this.viaFallback(messages, signal);
      throw error;
    }
  }

  async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
  ): Promise<ChatResult> {
    const message = await this.answerOf(messages, options.signal);
    return { generations: [{ text: message.text, message }] };
  }
}
