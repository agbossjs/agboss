import {
  BaseChatModel,
  type BaseChatModelCallOptions,
  type BindToolsInput,
} from "@langchain/core/language_models/chat_models";
import type { CallbackManagerForLLMRun } from "@langchain/core/callbacks/manager";
import type { BaseMessage } from "@langchain/core/messages";
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs";

/** A chat model made on its first call, once: a failed make is not kept, the next call makes it again. */
export class LateModel {
  #made: Promise<BaseChatModel> | undefined;

  constructor(private readonly make: () => Promise<BaseChatModel>) {}

  get(): Promise<BaseChatModel> {
    this.#made ??= this.make().catch((error: unknown) => {
      this.#made = undefined;
      throw error;
    });
    return this.#made;
  }
}

/**
 * A chat model whose client is loaded on its first call (#956): `chat()` stays synchronous and the
 * root import does not load the client's SDK. The tools and their binding are passed on to the real
 * model; its run is not traced twice (this model's run is the call's).
 */
export class LazyChatModel extends BaseChatModel {
  constructor(
    private readonly late: LateModel,
    private readonly tools: readonly BindToolsInput[] = [],
    private readonly binding: Partial<BaseChatModelCallOptions> = {},
  ) {
    super({});
  }

  _llmType(): string {
    return "agboss-lazy";
  }

  override bindTools(
    tools: BindToolsInput[],
    binding: Partial<BaseChatModelCallOptions> = {},
  ): LazyChatModel {
    return new LazyChatModel(this.late, tools, binding);
  }

  private async modelOf(): Promise<Pick<BaseChatModel, "invoke" | "stream">> {
    const real = await this.late.get();
    if (this.tools.length === 0) return real;
    const bound = real.bindTools?.([...this.tools], this.binding);
    if (bound === undefined) throw new Error("the chat model cannot call tools");
    return bound;
  }

  async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
  ): Promise<ChatResult> {
    const model = await this.modelOf();
    const message = await model.invoke(messages, callOf(options));
    return { generations: [{ text: message.text, message }] };
  }

  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const model = await this.modelOf();
    for await (const message of await model.stream(messages, callOf(options))) {
      const chunk = new ChatGenerationChunk({ text: message.text, message });
      yield chunk;
      await runManager?.handleLLMNewToken(chunk.text);
    }
  }
}

/** What the call passes on: no callbacks of its own, its signal, its stop words. */
const callOf = (options: BaseChatModelCallOptions) => ({
  callbacks: [],
  ...(options.signal === undefined ? {} : { signal: options.signal }),
  ...(options.stop === undefined ? {} : { stop: options.stop }),
});
