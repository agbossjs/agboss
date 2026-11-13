import type { CallbackManagerForLLMRun, Callbacks } from "@langchain/core/callbacks/manager";
import type {
  BaseLanguageModelInput,
  StructuredOutputMethodOptions,
} from "@langchain/core/language_models/base";
import {
  BaseChatModel,
  type BaseChatModelCallOptions,
  type BindToolsInput,
  type LangSmithParams,
} from "@langchain/core/language_models/chat_models";
import type { AIMessageChunk, BaseMessage, BaseMessageLike } from "@langchain/core/messages";
import type { ChatGenerationChunk, ChatResult, LLMResult } from "@langchain/core/outputs";
import type { BasePromptValueInterface } from "@langchain/core/prompt_values";
import { RunnableLambda, type Runnable } from "@langchain/core/runnables";

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
 * A chat model whose client is not loaded yet (#956): `chat()` is synchronous and the root import
 * does not load the client's SDK. Inside an application it is never made — assembly loads the client
 * and `chat()` returns the client itself — so this is for a `chat()` made before anything loaded it.
 * Every call is the real model's own, made on its first use: its run, its options (all of them, the
 * callbacks included), its usage, finish reasons and ids, and its `withStructuredOutput`.
 */
export class LazyChatModel extends BaseChatModel {
  constructor(
    private readonly late: LateModel,
    private readonly ls: LangSmithParams,
    private readonly tools: readonly BindToolsInput[] = [],
    private readonly binding: Partial<BaseChatModelCallOptions> = {},
  ) {
    super({});
  }

  _llmType(): string {
    return "agboss-lazy";
  }

  override getLsParams(): LangSmithParams {
    return this.ls;
  }

  override bindTools(
    tools: BindToolsInput[],
    binding: Partial<BaseChatModelCallOptions> = {},
  ): LazyChatModel {
    return new LazyChatModel(this.late, this.ls, tools, binding);
  }

  /** The real model with the tools bound to this one: invoke and stream, like a bound model's. */
  private async runnableOf(): Promise<Runnable<BaseLanguageModelInput, AIMessageChunk>> {
    const real = await this.late.get();
    if (this.tools.length === 0) return real;
    const bound = real.bindTools?.([...this.tools], this.binding);
    if (bound === undefined) throw new Error("the chat model cannot call tools");
    return bound;
  }

  override async invoke(
    input: BaseLanguageModelInput,
    options?: Partial<BaseChatModelCallOptions>,
  ): Promise<AIMessageChunk> {
    return (await this.runnableOf()).invoke(input, options);
  }

  override async *_streamIterator(
    input: BaseLanguageModelInput,
    options?: Partial<BaseChatModelCallOptions>,
  ): AsyncGenerator<AIMessageChunk> {
    yield* await (await this.runnableOf()).stream(input, options);
  }

  override async generate(
    messages: BaseMessageLike[][],
    options?: string[] | Partial<BaseChatModelCallOptions>,
    callbacks?: Callbacks,
  ): Promise<LLMResult> {
    return (await this.late.get()).generate(messages, options, callbacks);
  }

  override async generatePrompt(
    promptValues: BasePromptValueInterface[],
    options?: string[] | Partial<BaseChatModelCallOptions>,
    callbacks?: Callbacks,
  ): Promise<LLMResult> {
    return (await this.late.get()).generatePrompt(promptValues, options, callbacks);
  }

  async _generate(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    return (await this.late.get())._generate(messages, options, runManager);
  }

  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this["ParsedCallOptions"],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    yield* (await this.late.get())._streamResponseChunks(messages, options, runManager);
  }

  /**
   * The real model's own structured output (its method, its wire form, its parser), made when the
   * call comes: a runnable that loads the model first and runs the real chain as its child.
   */
  override withStructuredOutput<RunOutput extends object>(
    outputSchema: object,
    config?: StructuredOutputMethodOptions,
  ): Runnable<BaseLanguageModelInput, RunOutput>;
  override withStructuredOutput(
    outputSchema: object,
    config?: StructuredOutputMethodOptions<true>,
  ): Runnable<BaseLanguageModelInput, { raw: BaseMessage; parsed: object }>;
  override withStructuredOutput(
    outputSchema: object,
    config?: StructuredOutputMethodOptions<boolean>,
  ): Runnable<BaseLanguageModelInput> {
    return RunnableLambda.from(async (input: BaseLanguageModelInput, options) => {
      const real = await this.late.get();
      return config?.includeRaw === true
        ? real
            .withStructuredOutput(outputSchema, { ...config, includeRaw: true })
            .invoke(input, options)
        : real
            .withStructuredOutput(outputSchema, { ...config, includeRaw: false })
            .invoke(input, options);
    });
  }
}
