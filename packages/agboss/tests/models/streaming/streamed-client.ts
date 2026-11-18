import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { loadChatOpenAI } from "../../../src/models/chat-openai.js";
import { PromptCaching, Reasoning } from "../../../src/models/index.js";
import { StreamOpenRouterProvider } from "./http-streaming.fixture.js";
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

/**
 * The client an OpenRouter-like provider makes on `server` — its own `chat()`, so the client is
 * built and its fetch composed as an application's are (#1231: the host and the usage-once rule
 * live in that fetch).
 */
export async function clientOn(server: SseServer): Promise<BaseChatModel> {
  await loadChatOpenAI(); // inside an application the client is loaded: `chat()` returns it
  return new StreamOpenRouterProvider().chat({
    settings: { model: "stream/model", temperature: 0, maxTokens: 1000 },
    reasoning: Reasoning.modelDecides(),
    promptCaching: PromptCaching.off(),
    connection: {
      provider: "stream-or-1231-model-provider",
      baseUrl: "http://primary-1005.test/v1",
      apiKey: "key",
      fetch: server.send,
    },
  });
}
