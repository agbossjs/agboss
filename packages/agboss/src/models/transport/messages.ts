import {
  AIMessage,
  ToolMessage,
  type BaseMessage,
  type MessageContent,
} from "@langchain/core/messages";
import type { BindToolsInput } from "@langchain/core/language_models/chat_models";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import { partOfBlock, partsOfContent } from "../content.js";
import { ModelProviderError } from "../model-provider.decorator.js";
import {
  ModelProviderMessageRole,
  type ModelProviderMessage,
  type ModelProviderResponse,
  type ModelProviderToolCall,
  type ModelProviderToolDefinition,
} from "./transport.js";

/**
 * The conversation as a transport provider reads it (#385): LangChain's messages turned into the
 * framework's plain `ModelProviderMessage`s, the bound tools into `ModelProviderToolDefinition`s,
 * and the provider's `ModelProviderResponse` back into the `AIMessage` the agent loop reads.
 */

const ROLES: Readonly<Record<string, ModelProviderMessageRole>> = {
  system: ModelProviderMessageRole.System,
  human: ModelProviderMessageRole.User,
  ai: ModelProviderMessageRole.Assistant,
  tool: ModelProviderMessageRole.Tool,
};

/**
 * The text of a message: its text blocks joined. A file part (`agboss_part`) is carried in `parts`,
 * never as text (#899); any other block cannot be carried by a transport.
 */
function textOf(content: MessageContent, provider: string): string {
  if (typeof content === "string") return content;
  return content
    .map((block) => {
      if (block.type === "text" && typeof block.text === "string") return block.text;
      if (partOfBlock(block) !== undefined) return "";
      throw new ModelProviderError({
        message: `${provider}: a transport provider carries text and file parts only, not a "${block.type}" part`,
      });
    })
    .join("");
}

const toolCallsOf = (message: AIMessage): readonly ModelProviderToolCall[] =>
  (message.tool_calls ?? []).map((call) => ({
    id: call.id ?? "",
    name: call.name,
    arguments: call.args,
  }));

/** One LangChain message as a transport's message. */
function providerMessageOf(message: BaseMessage, provider: string): ModelProviderMessage {
  const parts = partsOfContent(message.content);
  const role = ROLES[message.type];
  if (role === undefined)
    throw new ModelProviderError({
      message: `${provider}: a "${message.type}" message has no transport role`,
    });
  const text = textOf(message.content, provider);
  const files = parts.length === 0 ? {} : { parts };
  if (AIMessage.isInstance(message)) {
    const toolCalls = toolCallsOf(message);
    return toolCalls.length === 0 ? { role, text, ...files } : { role, text, ...files, toolCalls };
  }
  if (ToolMessage.isInstance(message))
    return { role, text, ...files, toolCallId: message.tool_call_id };
  return { role, text, ...files };
}

/** The conversation for `complete(request)`. */
export const providerMessagesOf = (
  messages: readonly BaseMessage[],
  provider: string,
): readonly ModelProviderMessage[] =>
  messages.map((message) => providerMessageOf(message, provider));

/** The tools bound to the chat model (OpenAI's form) as the transport's definitions. */
export function toolDefinitionsOf(
  tools: readonly BindToolsInput[],
): readonly ModelProviderToolDefinition[] {
  return tools.map((tool) => {
    const definition = convertToOpenAITool(tool).function;
    return {
      name: definition.name,
      description: definition.description ?? "",
      parameters: { ...definition.parameters },
    };
  });
}

/** Whether `complete()` answered the response's shape (it is the project's code: checked once). */
function checkResponse(
  response: unknown,
  provider: string,
): asserts response is ModelProviderResponse {
  const isObject = typeof response === "object" && response !== null;
  const usage: unknown = isObject ? Reflect.get(response, "usage") : undefined;
  const hasUsage =
    typeof usage === "object" &&
    usage !== null &&
    typeof Reflect.get(usage, "inputTokens") === "number" &&
    typeof Reflect.get(usage, "outputTokens") === "number";
  if (isObject && typeof Reflect.get(response, "text") === "string" && hasUsage) return;
  throw new ModelProviderError({
    message: `${provider}: complete(request) must answer { text, toolCalls?, usage: { inputTokens, outputTokens }, cost?, finishReason? }`,
  });
}

/** A token count a JavaScript provider may leave out (the types ask for it): none is 0. */
const countOf = (count: number): number => (Number.isFinite(count) ? count : 0);

/** The provider's answer as the agent loop's message: text, tool calls, usage, cost, finish reason. */
export function aiMessageOf(response: unknown, model: string, provider: string): AIMessage {
  checkResponse(response, provider);
  const { usage } = response;
  return new AIMessage({
    content: response.text,
    tool_calls: (response.toolCalls ?? []).map((call) => ({
      id: call.id,
      name: call.name,
      args: { ...call.arguments },
      type: "tool_call" as const,
    })),
    usage_metadata: {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      total_tokens: usage.inputTokens + usage.outputTokens,
      input_token_details: {
        cache_read: countOf(usage.cacheReadTokens),
        cache_creation: countOf(usage.cacheWriteTokens),
      },
    },
    response_metadata: {
      model_name: model,
      usage: response.cost === undefined ? {} : { cost: response.cost },
      ...(response.finishReason === undefined ? {} : { finish_reason: response.finishReason }),
    },
  });
}
