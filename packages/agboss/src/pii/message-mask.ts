import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
  type MessageContent,
} from "@langchain/core/messages";
import { asRecord, mappedStringsAsync } from "./strings.js";

/**
 * One message with every text through a mask (#120): its content and, for a model's move, each
 * call's arguments. `isIncoming` tells what came into the execution (instructions, memory, input,
 * tool results) from what a model said — a block rule refuses only the first.
 */
export type MessageTextMask = (text: string, isIncoming: boolean) => Promise<string>;

async function maskedContent(
  content: MessageContent,
  mask: MessageTextMask,
  isIncoming: boolean,
): Promise<MessageContent> {
  if (typeof content === "string") return mask(content, isIncoming);
  return (await mappedStringsAsync(content, (text) => mask(text, isIncoming))) as MessageContent;
}

/** The message rebuilt of its kind, its texts masked. */
export async function maskedMessageOf(
  message: BaseMessage,
  mask: MessageTextMask | ((text: string) => Promise<string>),
): Promise<BaseMessage> {
  if (message instanceof AIMessage) {
    const toolCalls = [];
    for (const call of message.tool_calls ?? []) {
      const args = await mappedStringsAsync(call.args, (text) => mask(text, false));
      toolCalls.push({ ...call, args: asRecord(args) });
    }
    const content = await maskedContent(message.content, mask, false);
    return new AIMessage({ content, tool_calls: toolCalls });
  }
  const content = await maskedContent(message.content, mask, true);
  if (message instanceof ToolMessage)
    return new ToolMessage({ tool_call_id: message.tool_call_id, content });
  if (message instanceof SystemMessage) return new SystemMessage({ content });
  return new HumanMessage({ content });
}
