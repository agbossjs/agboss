import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import {
  BaseChatModel,
  type BaseChatModelCallOptions,
  type BindToolsInput,
} from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import type { Cassette, StoredReply } from "./vcr-cassette.js";
import { requestHashOf } from "./vcr-cassette.js";

/** What a chat request is matched by: the model, the bound tools and every message's role and content. */
export function chatRequestOf(
  model: string,
  messages: readonly BaseMessage[],
  tools: readonly BindToolsInput[],
): string {
  return requestHashOf({
    model,
    tools,
    messages: messages.map((message) => ({
      role: message.type,
      content: message.content,
      toolCalls: AIMessage.isInstance(message)
        ? (message.tool_calls ?? []).map((call) => ({ name: call.name, args: call.args }))
        : [],
    })),
  });
}

type ReplyFields = Pick<
  AIMessage,
  "content" | "tool_calls" | "invalid_tool_calls" | "usage_metadata" | "response_metadata"
>;

const storedReplyOf = (reply: ReplyFields): StoredReply => ({
  content: reply.content,
  tool_calls: reply.tool_calls ?? [],
  ...(reply.invalid_tool_calls === undefined || reply.invalid_tool_calls.length === 0
    ? {}
    : { invalid_tool_calls: reply.invalid_tool_calls }),
  ...(reply.usage_metadata === undefined ? {} : { usage_metadata: reply.usage_metadata }),
  response_metadata: reply.response_metadata,
});

/**
 * A chat model that answers from the cassette, or — while recording — asks the real model and
 * keeps its reply. The real model is created only when recording, so a replay needs no key.
 */
export class VcrChatModel extends BaseChatModel {
  constructor(
    private readonly cassette: Cassette,
    private readonly key: string,
    private readonly model: string,
    private readonly real: () => BaseChatModel,
    private readonly tools: readonly BindToolsInput[] = [],
    private readonly binding: Partial<BaseChatModelCallOptions> = {},
  ) {
    super({});
  }

  _llmType(): string {
    return "vcr";
  }

  /** The tools and their binding (#649); the binding reaches the real model, never the request's hash. */
  override bindTools(
    tools: BindToolsInput[],
    binding: Partial<BaseChatModelCallOptions> = {},
  ): VcrChatModel {
    return new VcrChatModel(this.cassette, this.key, this.model, this.real, tools, binding);
  }

  /** The recorded reply; a text reply streams as one token, as the scripted model's does. */
  async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const request = chatRequestOf(this.model, messages, this.tools);
    const reply = this.cassette.records(this.key)
      ? await this.#record(messages, request, options.signal)
      : this.cassette.chat(this.key, request);
    const message = new AIMessage({ ...reply }); // a copy: LangChain fills in the fields it is given
    if (message.text !== "") await runManager?.handleLLMNewToken(message.text);
    return { generations: [{ text: message.text, message }] };
  }

  async #record(
    messages: BaseMessage[],
    request: string,
    signal: AbortSignal | undefined,
  ): Promise<StoredReply> {
    const real = this.real();
    const model =
      this.tools.length === 0 || real.bindTools === undefined
        ? real
        : real.bindTools([...this.tools], this.binding);
    const reply = storedReplyOf(await model.invoke(messages, { signal }));
    this.cassette.record({ kind: "chat", key: this.key, request, reply });
    return reply;
  }
}
