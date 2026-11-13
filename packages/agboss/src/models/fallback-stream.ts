import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import type { BaseLanguageModelInput } from "@langchain/core/language_models/base";
import { AIMessage, AIMessageChunk, type BaseMessage } from "@langchain/core/messages";
import type { Runnable } from "@langchain/core/runnables";
import type { ModelCost } from "./cost.js";
import { markedFallbackMessage } from "./fallback.js";
import { ModelProviderError } from "./model-provider.decorator.js";

/** A streamed call of a fallback model's chat model (#1005). */

/** Whether text of a call has gone out: a failed call that told text is a void one. */
export interface Told {
  text: boolean;
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
    ...(signal === undefined ? {} : { signal }),
  });
  let answer: AIMessageChunk | undefined;
  for await (const chunk of stream) {
    if (chunk.text !== "") {
      told.text = true;
      await runManager?.handleLLMNewToken(chunk.text);
    }
    answer = answer === undefined ? chunk : answer.concat(chunk);
  }
  if (answer === undefined) throw new ModelProviderError({ message: "the model answered nothing" });
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
    tool_calls: answer.tool_calls ?? [],
    invalid_tool_calls: answer.invalid_tool_calls ?? [],
    additional_kwargs: answer.additional_kwargs,
    response_metadata: answer.response_metadata,
    ...(answer.usage_metadata === undefined ? {} : { usage_metadata: answer.usage_metadata }),
    ...(answer.id === undefined ? {} : { id: answer.id }),
  });
  const marked = markedFallbackMessage(whole, model, cost);
  return new AIMessageChunk({
    content: marked.content,
    tool_calls: whole.tool_calls ?? [],
    additional_kwargs: whole.additional_kwargs,
    response_metadata: marked.response_metadata,
    ...(whole.usage_metadata === undefined ? {} : { usage_metadata: whole.usage_metadata }),
    ...(whole.id === undefined ? {} : { id: whole.id }),
  });
}
