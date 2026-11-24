import { ModelProviderError } from "../model-provider.decorator.js";
import type { ModelProviderStream, ModelProviderStreamResult } from "./transport.js";

const isAsyncIterable = (value: unknown): value is AsyncIterable<string> =>
  typeof value === "object" && value !== null && Symbol.asyncIterator in value;

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === "object" &&
  value !== null &&
  "then" in value &&
  typeof value.then === "function";

const RESULT_SHAPE = "{ usage: { inputTokens, outputTokens }, cost?, finishReason? }";

/** The source of a stream, its shape checked once (the project's code). */
export function sourceOf(stream: unknown, provider: string): ModelProviderStream {
  const isObject = typeof stream === "object" && stream !== null;
  const textStream: unknown = isObject ? Reflect.get(stream, "textStream") : undefined;
  const result: unknown = isObject ? Reflect.get(stream, "result") : undefined;
  if (!isAsyncIterable(textStream) || !isThenable(result))
    throw new ModelProviderError({
      message: `${provider}: stream(request) must answer { textStream: AsyncIterable<string>, result: Promise<${RESULT_SHAPE}> }`,
    });
  return {
    textStream,
    result: Promise.resolve(result).then((settled) => resultOf(settled, provider)),
  };
}

/**
 * Whether the stream's `result` settled to its shape (the project's code): an object whose `usage`
 * counts input and output tokens. Any other value is the project's bug, never a call of zero
 * tokens: the ledger and the budgets would be told less than was spent.
 */
function isResult(settled: unknown): settled is ModelProviderStreamResult {
  const usage: unknown =
    typeof settled === "object" && settled !== null ? Reflect.get(settled, "usage") : undefined;
  return (
    typeof usage === "object" &&
    usage !== null &&
    typeof Reflect.get(usage, "inputTokens") === "number" &&
    typeof Reflect.get(usage, "outputTokens") === "number"
  );
}

/** The settled `result`, checked: a malformed one fails the call, loudly. */
function resultOf(settled: unknown, provider: string): ModelProviderStreamResult {
  if (isResult(settled)) return settled;
  throw new ModelProviderError({
    message: `${provider}: stream(request).result must settle to ${RESULT_SHAPE}`,
  });
}
