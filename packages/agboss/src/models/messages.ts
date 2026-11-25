import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
  type MessageContent,
} from "@langchain/core/messages";
import {
  contentOf,
  partMetaOf,
  partOfBlock,
  type ModelInputPart,
  type PartMeta,
} from "./content.js";

/**
 * The framework's own message forms (#1313f): what a judge sends a chat model, and what an event or
 * a test shows of a call. No LangChain type is in them; the agent loop maps at its boundary.
 */

/** Who wrote a message. */
export type ModelMessageRole = "system" | "user" | "assistant" | "tool";

/** A message a judge or an arbiter sends its chat model: its role and its text or parts. */
export interface ModelMessage {
  readonly role: ModelMessageRole;
  readonly content: string | readonly ModelInputPart[];
}

/** A text block of a shown message. */
export interface ShownTextBlock {
  readonly type: "text";
  readonly text: string;
}

/** A block of a shown message: a text, or a file part by its meta, never its bytes (#899 §9). */
export type ShownBlock = ShownTextBlock | PartMeta;

/** What an event or a test shows of a message's content: a string, or blocks without any bytes. */
export type ShownContent = string | readonly ShownBlock[];

/** A tool call of a shown message: the tool's name and its arguments. */
export interface ShownToolCall {
  readonly id?: string;
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
}

/** One message of a model call, as an event shows it: plain data, files by their meta. */
export interface ShownModelMessage {
  readonly role: ModelMessageRole;
  readonly content: ShownContent;
  /** An assistant message's tool calls; absent = none. */
  readonly toolCalls?: readonly ShownToolCall[];
  /** A tool message: the id of the call it answers. */
  readonly toolCallId?: string;
}

const ROLE_OF_TYPE: Readonly<Record<string, ModelMessageRole>> = {
  system: "system",
  human: "user",
  ai: "assistant",
  tool: "tool",
};

/** A LangChain message's content as a shown one: a file part as its meta, any other block as its text. */
export function shownContentOf(content: MessageContent): ShownContent {
  if (typeof content === "string") return content;
  return content.map((block): ShownBlock => {
    const part = partOfBlock(block);
    if (part !== undefined) return partMetaOf(part);
    return {
      type: "text",
      text:
        block.type === "text" && typeof block.text === "string"
          ? block.text
          : JSON.stringify(block),
    };
  });
}

/** A LangChain message as an event shows it. */
export function shownMessageOf(message: BaseMessage): ShownModelMessage {
  const role = ROLE_OF_TYPE[message.type] ?? "user";
  const content = shownContentOf(message.content);
  if (AIMessage.isInstance(message) && (message.tool_calls ?? []).length > 0) {
    const toolCalls = (message.tool_calls ?? []).map((call) => ({
      ...(call.id === undefined ? {} : { id: call.id }),
      name: call.name,
      args: call.args,
    }));
    return { role, content, toolCalls };
  }
  if (ToolMessage.isInstance(message)) return { role, content, toolCallId: message.tool_call_id };
  return { role, content };
}

/** The conversation as an event shows it. */
export const shownMessagesOf = (messages: readonly BaseMessage[]): readonly ShownModelMessage[] =>
  messages.map(shownMessageOf);

/** A judge's `ModelMessage`s as the agent loop's chat messages. */
export function chatMessagesOf(messages: readonly ModelMessage[]): BaseMessage[] {
  return messages.map((message): BaseMessage => {
    const content =
      typeof message.content === "string"
        ? message.content
        : contentOf(
            message.content.map((part) => (part.kind === "text" ? part.text : "")).join(""),
            message.content.flatMap((part) => (part.kind === "text" ? [] : [part])),
          );
    if (message.role === "system") return new SystemMessage({ content });
    if (message.role === "assistant") return new AIMessage({ content });
    if (message.role === "tool") return new ToolMessage({ content, tool_call_id: "" });
    return new HumanMessage({ content });
  });
}

/** The text of a shown content: its text blocks joined, file parts left out. */
export function shownTextOf(content: ShownContent): string {
  if (typeof content === "string") return content;
  return content.map((block) => (block.type === "text" ? block.text : "")).join("");
}
