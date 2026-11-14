import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import type { BaseMessage } from "@langchain/core/messages";
import type { ChatGenerationChunk } from "@langchain/core/outputs";
import type { ChatOpenAI } from "@langchain/openai";
import { lazyLoad } from "../infrastructure/clock.js";

/**
 * The OpenAI chat client (`@langchain/openai`, with the OpenAI SDK behind it: hundreds of modules),
 * loaded when an application is assembled or on a model's first call, not when the root is read
 * (#956). A failed load leaves nothing behind: the next call tries again.
 */
let loaded: typeof ChatOpenAI | undefined;

/**
 * The client as a streamed call needs it (#1005): LangChain's own streaming call keeps a chunk's
 * `generationInfo` (`finish_reason`, the model) out of the answer's `response_metadata`, which
 * `_generate` merges for a plain call — so a streamed answer would never say it was cut at the limit.
 */
function withStreamedMetadata(Client: typeof ChatOpenAI): typeof ChatOpenAI {
  class StreamedMetadataChatOpenAI extends Client {
    override async *_streamResponseChunks(
      messages: BaseMessage[],
      options: this["ParsedCallOptions"],
      runManager?: CallbackManagerForLLMRun,
    ): AsyncGenerator<ChatGenerationChunk> {
      for await (const chunk of super._streamResponseChunks(messages, options, runManager)) {
        chunk.message.response_metadata = {
          ...chunk.generationInfo,
          ...chunk.message.response_metadata,
        };
        yield chunk;
      }
    }
  }
  // traces and logs name the client by its class: it is the OpenAI client for them
  Object.defineProperty(StreamedMetadataChatOpenAI, "name", { value: Client.name });
  return StreamedMetadataChatOpenAI;
}

/** Loads the client (`createApp` assembly, a lazy model's first call); a no-op once loaded. */
export async function loadChatOpenAI(): Promise<typeof ChatOpenAI> {
  loaded ??= withStreamedMetadata((await lazyLoad(import("@langchain/openai"))).ChatOpenAI);
  return loaded;
}

/** The client when something has loaded it, else `undefined`: `chat()` is synchronous. */
export const loadedChatOpenAI = (): typeof ChatOpenAI | undefined => loaded;
