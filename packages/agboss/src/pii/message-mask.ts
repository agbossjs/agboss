import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
  type ContentBlock,
  type MessageContent,
} from "@langchain/core/messages";
import { partOfBlock } from "../models/content.js";
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
  // a file part is passed through untouched — PII never sees bytes (#899); every other block's
  // strings are masked as before, a text block's or any other's
  const blocks: typeof content = [];
  for (const block of content) {
    if (partOfBlock(block) !== undefined) blocks.push(block);
    else if (block.type === "text" && typeof block.text === "string")
      blocks.push({ ...block, text: await mask(block.text, isIncoming) });
    else
      blocks.push(
        (await mappedStringsAsync(block, (text) =>
          mask(text, isIncoming),
        )) as (typeof content)[number],
      );
  }
  return blocks;
}

/** The message rebuilt of its kind with each content block through `shown` (a file part without its bytes, #899). */
export function messageWithBlocks(
  message: BaseMessage,
  shown: (block: ContentBlock) => ContentBlock,
): BaseMessage {
  const { content } = message;
  if (typeof content === "string") return message;
  const blocks = content.map(shown);
  if (message instanceof AIMessage)
    return new AIMessage({ content: blocks, tool_calls: message.tool_calls ?? [] });
  if (message instanceof ToolMessage)
    return new ToolMessage({ tool_call_id: message.tool_call_id, content: blocks });
  if (message instanceof SystemMessage) return new SystemMessage({ content: blocks });
  return new HumanMessage({ content: blocks });
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
