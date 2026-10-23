import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { costOf, extractTokenUsage } from "../finops/usage.js";
import { FALLBACK_MARK, isRecord } from "../finops/fallback-mark.js";
import { priceOf, type ModelCost } from "./cost.js";

/**
 * A fallback's answer (#202, moved to the chat model by #385): marked in its `usage` with the
 * model that served it and, for a fallback with a price table, its cost by that table — so the
 * call is accounted under the fallback's model and prices, never the primary's.
 */
export function markedFallbackMessage(
  message: BaseMessage,
  model: string,
  cost: ModelCost,
): BaseMessage {
  if (!(message instanceof AIMessage)) return message;
  const metadata = message.response_metadata;
  const usage = isRecord(metadata.usage) ? metadata.usage : {};
  const price = priceOf(cost, model);
  const priced = price === undefined ? {} : { cost: costOf(extractTokenUsage(message), price) };
  const marked = { ...usage, ...priced, [FALLBACK_MARK]: { model, priced: price !== undefined } };
  return new AIMessage({
    content: message.content,
    tool_calls: message.tool_calls ?? [],
    invalid_tool_calls: message.invalid_tool_calls ?? [],
    additional_kwargs: message.additional_kwargs,
    ...(message.usage_metadata === undefined ? {} : { usage_metadata: message.usage_metadata }),
    ...(message.id === undefined ? {} : { id: message.id }),
    response_metadata: { ...metadata, usage: marked },
  });
}
