import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { loadChatOpenAI } from "../../../src/models/chat-openai.js";
import { servedByFetch } from "../../../src/models/served-by.js";
import type { SseServer } from "./sse-server.js";

/** A handler that asks for a streamed call, as the run's stream handler does; `tokens` are what it heard. */
export class StreamAsker extends BaseCallbackHandler {
  name = "stream-asker";
  readonly lc_prefer_streaming = true;
  readonly tokens: string[] = [];

  override handleLLMNewToken(token: string): void {
    this.tokens.push(token);
  }
}

/** The OpenAI client the framework loads, on `server`, as an OpenRouter-like provider's client is made. */
export async function clientOn(server: SseServer): Promise<BaseChatModel> {
  const Client = await loadChatOpenAI();
  return new Client({
    apiKey: "key",
    model: "stream/model",
    maxRetries: 0,
    streamUsage: true,
    configuration: { baseURL: "http://primary-1005.test/v1", fetch: servedByFetch(server.send) },
  });
}
