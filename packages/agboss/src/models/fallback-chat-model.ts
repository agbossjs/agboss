import type { BaseLanguageModelInput } from "@langchain/core/language_models/base";
import {
  BaseChatModel,
  type BaseChatModelCallOptions,
  type BindToolsInput,
} from "@langchain/core/language_models/chat_models";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import type { AIMessageChunk, BaseMessage } from "@langchain/core/messages";
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs";
import type { Runnable } from "@langchain/core/runnables";
import { ModelCallError, type CircuitBreaker } from "./circuit-breaker.js";
import type { ModelCost } from "./cost.js";
import { isFailoverError } from "./failover-error.js";
import { markedFallbackMessage } from "./fallback.js";
import {
  partialSpendOf,
  withFailoverTrace,
  type EarlierShare,
} from "./transport/stream-partial.js";
import { ModelProviderError } from "./model-provider.decorator.js";
import { markedChunk, streamedAnswer } from "./fallback-stream.js";
import { discardStreamedText } from "./stream-discard.js";

/** One provider a call falls back to: its chat model, the model it is asked for, its prices. */
export interface FallbackTarget {
  readonly chatModel: () => BaseChatModel;
  /** The fallback's model for the primary's (`fallback.models`, a role it shares, else the same name). */
  readonly model: string;
  readonly cost: ModelCost | undefined;
  /** The fallback provider's `name`: the call it answers is recorded under it (#1399). */
  readonly provider: string;
}

/** What a primary chat model with a fallback chain is made of. */
export interface FallbackChatModelParts {
  readonly primary: BaseChatModel;
  /** The primary's breaker, when it has a policy: open, its calls go to the chain untried. */
  readonly breaker?: CircuitBreaker;
  /** The chain after the primary, in order: the first that answers serves the call. */
  readonly hops: readonly FallbackTarget[];
}

/** Whether a call failed because the breaker opened (the error, or one of its causes). */
function isCircuitOpen(error: unknown): boolean {
  for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) {
    if (cause instanceof ModelCallError && cause.code === "model.circuit-open") return true;
  }
  return false;
}

/**
 * A provider's chat model with its fallback chain (#202, at the chat model since #385 — so HTTP and
 * transport providers fall back to each other either way): while the primary's breaker is open, or
 * when a call fails for the provider's own reasons after its retries, the call goes to the next
 * provider of the chain as its mapped model, and its answer is marked so it is accounted under that
 * provider, model and prices. A streamed call falls back on an open breaker (#1311b).
 */
export class FallbackChatModel extends BaseChatModel {
  constructor(
    private readonly parts: FallbackChatModelParts,
    private readonly tools: readonly BindToolsInput[] = [],
    private readonly binding: Partial<BaseChatModelCallOptions> = {},
  ) {
    super({});
  }

  /** The primary's breaker is open: its calls are not tried. */
  async #isOpen(): Promise<boolean> {
    return (await this.parts.breaker?.isOpen()) === true;
  }

  _llmType(): string {
    return "agboss-fallback";
  }

  /** The tools and their binding (#649: `parallel_tool_calls`), passed on to whichever model answers. */
  override bindTools(
    tools: BindToolsInput[],
    binding: Partial<BaseChatModelCallOptions> = {},
  ): FallbackChatModel {
    return new FallbackChatModel(this.parts, tools, binding);
  }

  /** The chat model with the bound tools. */
  private boundOf(model: BaseChatModel): Runnable<BaseLanguageModelInput, AIMessageChunk> {
    const bound =
      this.tools.length === 0 ? model : model.bindTools?.([...this.tools], this.binding);
    if (bound === undefined)
      throw new ModelProviderError({ message: "the fallback's chat model cannot call tools" });
    return bound;
  }

  /** One call of a chat model with the bound tools; untraced: this model's run is the call's. */
  private async callOf(
    model: BaseChatModel,
    messages: BaseMessage[],
    signal?: AbortSignal,
  ): Promise<BaseMessage> {
    return this.boundOf(model).invoke(messages, {
      callbacks: [],
      ...(signal === undefined ? {} : { signal }),
    });
  }

  /** The call served by the first of the chain that answers; the last one's error when none does. */
  private async viaFallback(
    messages: BaseMessage[],
    signal: AbortSignal | undefined,
    failed?: unknown,
  ): Promise<BaseMessage> {
    let last = failed;
    for (const hop of this.parts.hops) {
      try {
        const answer = await this.callOf(hop.chatModel(), messages, signal);
        return markedFallbackMessage(answer, hop);
      } catch (error) {
        if (!isFailoverError(error, signal)) throw error;
        last = error;
      }
    }
    throw last;
  }

  private async answerOf(messages: BaseMessage[], signal?: AbortSignal): Promise<BaseMessage> {
    if (await this.#isOpen()) return this.viaFallback(messages, signal);
    try {
      return await this.callOf(this.parts.primary, messages, signal);
    } catch (error) {
      // the primary is down: its breaker open (or half-open with every probe taken), or the call
      // failed after its retries — the fallback answers, once, so nothing is charged twice
      if (!isFailoverError(error, signal)) throw error;
      return this.viaFallback(messages, signal, error);
    }
  }

  async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
  ): Promise<ChatResult> {
    const message = await this.answerOf(messages, options.signal);
    return { generations: [{ text: message.text, message }] };
  }

  /**
   * The fallback's streamed answer, marked as the fallback's (accounted under its provider, model and
   * prices), with what the providers before it spent. When it fails mid-way, its error says who was
   * serving and what the earlier ones had spent (#1399): the spend is recorded under them, not the primary.
   */
  private async streamedViaFallback(
    messages: BaseMessage[],
    runManager: CallbackManagerForLLMRun | undefined,
    signal: AbortSignal | undefined,
    earlier: readonly EarlierShare[] = [],
  ): Promise<AIMessageChunk> {
    const [fallback] = this.parts.hops;
    if (fallback === undefined)
      throw new ModelProviderError({ message: "the fallback chain is empty" });
    const model = this.boundOf(fallback.chatModel());
    try {
      const answer = await streamedAnswer(model, messages, runManager, signal, {
        text: false,
        chars: 0,
      });
      return markedChunk(answer, fallback, earlier);
    } catch (error) {
      throw withFailoverTrace(error, { server: fallback, earlier });
    }
  }

  /**
   * The streamed call (#1005): the primary's tokens, or — its breaker open — the fallback's. A
   * primary that dies and opens its breaker is answered by the fallback from the start: before any text
   * it is transparent, after text went out a `StreamEventKind.Discarded` event says it is void.
   */
  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const { signal } = options;
    const told = { text: false, chars: 0 };
    const answered = async (): Promise<AIMessageChunk> => {
      if (await this.#isOpen()) {
        return this.streamedViaFallback(messages, runManager, signal);
      }
      try {
        return await streamedAnswer(
          this.boundOf(this.parts.primary),
          messages,
          runManager,
          signal,
          told,
        );
      } catch (error) {
        // a failure that opened the breaker is answered by the fallback, whether text went out or
        // not (#1311b): before any text it is transparent, after it the text is retracted below
        const opened = signal?.aborted !== true && (isCircuitOpen(error) || (await this.#isOpen()));
        if (!opened) throw error;
        if (told.text) await discardStreamedText(runManager, errorText(error));
        // the primary billed what it streamed before it died: its share, recorded under it (#1399)
        const share: EarlierShare = {
          reported: partialSpendOf(error),
          chars: told.chars,
        };
        return this.streamedViaFallback(messages, runManager, signal, told.text ? [share] : []);
      }
    };
    const message = await answered();
    yield new ChatGenerationChunk({ message, text: message.text });
  }
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : "the provider's stream failed";
