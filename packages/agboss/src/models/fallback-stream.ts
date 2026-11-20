import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import type { BaseLanguageModelInput } from "@langchain/core/language_models/base";
import { AIMessage, AIMessageChunk, type BaseMessage } from "@langchain/core/messages";
import type { Runnable } from "@langchain/core/runnables";
import type { ModelCost } from "./cost.js";
import { markedFallbackMessage } from "./fallback.js";
import { EventStreamError } from "./calls/event-stream-guard.js";

/** A streamed call of a fallback model's chat model (#1005). */

/** Whether text of a call has gone out: a failed call that told text is a void one. */
export interface Told {
  text: boolean;
}

/**
 * `fields` without those set to `undefined`: a config or a message takes a field that is absent, and
 * one that is `undefined` is not the same value (a key that is present, a `"id" in message`).
 */
export function presentFields<T extends Record<string, unknown>>(
  fields: T,
): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };
}

/**
 * One streamed call (untraced: the fallback model's run is the call's): its tokens go to the run
 * as they come — the run's stream hears them — and the whole answer is returned.
 */
export async function streamedAnswer(
  model: Runnable<BaseLanguageModelInput, AIMessageChunk>,
  messages: BaseMessage[],
  runManager: CallbackManagerForLLMRun | undefined,
  signal: AbortSignal | undefined,
  told: Told,
): Promise<AIMessageChunk> {
  const stream = await model.stream(messages, {
    callbacks: [],
    ...presentFields({ signal }),
  });
  let answer: AIMessageChunk | undefined;
  for await (const chunk of stream) {
    if (chunk.text !== "") {
      told.text = true;
      await runManager?.handleLLMNewToken(chunk.text);
    }
    answer = answer === undefined ? chunk : answer.concat(chunk);
  }
  if (answer === undefined) throw new EventStreamError("the model answered nothing");
  return answer;
}

/** A fallback's streamed answer marked with the fallback's model and prices (the mark is made on a message). */
export function markedChunk(
  answer: AIMessageChunk,
  model: string,
  cost: ModelCost,
): AIMessageChunk {
  const whole = new AIMessage({
    content: answer.content,
    // Stryker disable next-line ArrayDeclaration: a chunk always has its calls, the default is the type's
    tool_calls: answer.tool_calls ?? [],
    additional_kwargs: answer.additional_kwargs,
    response_metadata: answer.response_metadata,
    ...presentFields({ usage_metadata: answer.usage_metadata, id: answer.id }),
  });
  const marked = markedFallbackMessage(whole, model, cost);
  return new AIMessageChunk({
    content: marked.content,
    // Stryker disable next-line ArrayDeclaration: a message always has its calls, the default is the type's
    tool_calls: whole.tool_calls ?? [],
    additional_kwargs: whole.additional_kwargs,
    response_metadata: marked.response_metadata,
    ...presentFields({ usage_metadata: whole.usage_metadata, id: whole.id }),
  });
}
