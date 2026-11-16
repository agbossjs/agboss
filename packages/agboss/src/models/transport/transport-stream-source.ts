import { ModelProviderError } from "../model-provider.decorator.js";
import type { ModelProviderStream, ModelProviderUsage } from "./transport.js";

const isAsyncIterable = (value: unknown): value is AsyncIterable<string> =>
  typeof value === "object" && value !== null && Symbol.asyncIterator in value;

const isThenable = (value: unknown): value is PromiseLike<ModelProviderUsage> =>
  typeof value === "object" &&
  value !== null &&
  "then" in value &&
  typeof value.then === "function";

/** The source of a stream, its shape checked once (the project's code). */
export function sourceOf(stream: unknown, provider: string): ModelProviderStream {
  const isObject = typeof stream === "object" && stream !== null;
  const textStream: unknown = isObject ? Reflect.get(stream, "textStream") : undefined;
  const usage: unknown = isObject ? Reflect.get(stream, "usage") : undefined;
  if (!isAsyncIterable(textStream) || !isThenable(usage))
    throw new ModelProviderError({
      message: `${provider}: stream(request) must answer { textStream: AsyncIterable<string>, usage: Promise<{ inputTokens, outputTokens }> }`,
    });
  return { textStream, usage: Promise.resolve(usage) };
}
