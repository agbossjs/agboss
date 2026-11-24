import { describe, expect, it } from "vitest";
import {
  FinishReason,
  ModelFailure,
  ModelProviderFailureError,
} from "../../../src/models/index.js";
import { ModelProviderError } from "../../../src/models/model-provider.decorator.js";
import { transportStreamCarrier } from "../../../src/models/transport/transport-stream.js";
import type { StreamedAnswer } from "../../../src/models/transport/transport-stream.js";
import type { ModelProviderRequest, ModelProviderStream } from "../../../src/models/index.js";
import { Reasoning } from "../../../src/models/reasoning.js";
import { PromptCaching } from "../../../src/models/prompt-caching.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { seconds, usd } from "../../../src/units/index.js";

/** #1011: the streamed carrier's end — what the breaker is told, and that a failed stream is stopped. */

const USAGE = { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 };

const REQUEST: Omit<ModelProviderRequest, "signal"> = {
  model: "m",
  messages: [],
  tools: [],
  temperature: 0,
  maxTokens: undefined,
  reasoning: Reasoning.off(),
  promptCaching: PromptCaching.off(),
};

class Breaker {
  readonly told: string[] = [];
  recordSuccess(): Promise<void> {
    this.told.push("success");
    return Promise.resolve();
  }
  recordFailure(): Promise<void> {
    this.told.push("failure");
    return Promise.resolve();
  }
}

async function* chunks(parts: readonly string[], then?: () => Promise<void>) {
  for (const part of parts) yield part;
  await then?.();
}

/** Opens `source` through the carrier and returns its answer, with the request's own signal. */
async function opened(source: (signal: AbortSignal) => ModelProviderStream, breaker: Breaker) {
  const clock = new VirtualClock();
  const seen: { signal?: AbortSignal } = {};
  const carrier = transportStreamCarrier(
    (request) => {
      seen.signal = request.signal;
      return source(request.signal);
    },
    REQUEST,
    undefined,
    { provider: "p", clock, timeout: seconds(5), breaker },
  );
  const attempt = await carrier.send(new AbortController().signal, {
    gate: undefined,
    timeout: seconds(5),
    clock,
  });
  if (attempt.kind !== "answered") throw new Error("not answered", { cause: attempt });
  const answer: StreamedAnswer = attempt.answer;
  return { answer, clock, seen };
}

describe("#1249: a streamed call's end carries its cost and finish reason", () => {
  it("the result's cost and finishReason are the response's, as complete()'s are", async () => {
    const { answer } = await opened(
      () => ({
        textStream: chunks(["cut"]),
        result: Promise.resolve({
          usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
          cost: usd(0.5),
          finishReason: FinishReason.Length,
        }),
      }),
      new Breaker(),
    );

    const response = await answer.consume(() => Promise.resolve());

    expect(response).toEqual({
      text: "cut",
      usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
      cost: 0.5,
      finishReason: "length",
    });
  });

  it("an empty first chunk is no text: a failure right after it fails the attempt, not the answer", async () => {
    const failure = new ModelProviderFailureError({ failure: ModelFailure.ServerError });
    const breaker = new Breaker();

    const failed = opened(
      () => ({
        textStream: chunks([""], () => Promise.reject(failure)),
        result: Promise.reject(failure),
      }),
      breaker,
    );

    // not an answer: the attempt failed before any text, which the retry policy may retry
    await expect(failed).rejects.toMatchObject({
      cause: { kind: "threw", error: failure },
    });
  });
});

describe("#1011: a streamed call's end is told to the breaker once", () => {
  it("a completed stream is one success", async () => {
    const breaker = new Breaker();
    const { answer } = await opened(
      () => ({
        textStream: chunks(["a", "b"]),
        result: Promise.resolve({ usage: USAGE }),
      }),
      breaker,
    );

    const response = await answer.consume(() => Promise.resolve());

    expect(response).toEqual({ text: "ab", usage: USAGE });
    expect(breaker.told).toEqual(["success"]);
  });

  it("a stalled stream is one failure, typed, and the SDK is told to stop", async () => {
    const breaker = new Breaker();
    const never = (): Promise<void> => new Promise<void>(() => undefined);
    const { answer, clock, seen } = await opened(
      () => ({ textStream: chunks(["a"], never), result: new Promise(() => undefined) }),
      breaker,
    );

    const consumed = answer
      .consume(() => Promise.resolve())
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    await clock.advance(seconds(6));
    const error = await consumed;

    expect(error).toBeInstanceOf(ModelProviderFailureError);
    expect(breaker.told).toEqual(["failure"]);
    expect(seen.signal?.aborted).toBe(true);
  });
});

/** A promise settling to `value`, whatever it is: a JS project's stream is checked at run time. */
const settledTo = (value: unknown): Promise<unknown> => Promise.resolve(value);

/**
 * A stream with `fields` as they are — the shape a JS project may hand in, which the types refuse:
 * a well-typed stream whose own fields are replaced, so no type assertion is needed.
 */
function streamShaped(fields: Readonly<Record<string, unknown>>): ModelProviderStream {
  const stream: ModelProviderStream = {
    textStream: chunks([]),
    result: new Promise(() => undefined),
  };
  Reflect.deleteProperty(stream, "textStream");
  Reflect.deleteProperty(stream, "result");
  for (const [key, value] of Object.entries(fields)) Reflect.set(stream, key, value);
  return stream;
}

const settledError = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

describe("#1311: a stream settles with result: { usage, cost?, finishReason? }", () => {
  it("the result's usage — cached tokens too — is the response's usage, as complete()'s is", async () => {
    const usage = { inputTokens: 10, outputTokens: 4, cacheReadTokens: 6, cacheWriteTokens: 2 };
    const { answer } = await opened(
      () => ({ textStream: chunks(["a"]), result: Promise.resolve({ usage, cost: usd(0.25) }) }),
      new Breaker(),
    );

    const response = await answer.consume(() => Promise.resolve());

    expect(response).toEqual({ text: "a", usage, cost: 0.25 });
  });

  it("a result without cost or finishReason gives a response without them", async () => {
    const { answer } = await opened(
      () => ({
        textStream: chunks(["a"]),
        result: Promise.resolve({ usage: USAGE, cost: undefined, finishReason: undefined }),
      }),
      new Breaker(),
    );

    const response = await answer.consume(() => Promise.resolve());

    expect(response).toEqual({ text: "a", usage: USAGE });
    expect(Object.keys(response)).toEqual(["text", "usage"]);
  });

  it.each([
    ["the old flat usage", { inputTokens: 1, outputTokens: 2 }],
    ["no usage", { cost: 0.5 }],
    ["a usage without its counts", { usage: { inputTokens: "1", outputTokens: 2 } }],
    ["null", null],
    ["a number", 3],
  ])(
    "a result that settles to %s fails the call as the project's bug, never as zero tokens",
    async (_name, settled) => {
      const breaker = new Breaker();
      const { answer } = await opened(
        () =>
          streamShaped({ textStream: chunks(["secret model text"]), result: settledTo(settled) }),
        breaker,
      );

      const error = await settledError(answer.consume(() => Promise.resolve()));

      expect(error).toBeInstanceOf(ModelProviderError);
      expect((error as Error).message).toBe(
        "p: stream(request).result must settle to { usage: { inputTokens, outputTokens }, cost?, finishReason? }",
      );
      expect((error as Error).message).not.toContain("secret model text");
      // the project's bug is no failure of the provider: the breaker is told nothing
      expect(breaker.told).toEqual([]);
    },
  );

  it("a stream without result (the old usage promise) is refused before any chunk is read", async () => {
    const breaker = new Breaker();
    const opening = opened(
      () => streamShaped({ textStream: chunks(["a"]), usage: Promise.resolve(USAGE) }),
      breaker,
    );

    await expect(opening).rejects.toMatchObject({
      cause: {
        kind: "threw",
        isRejected: true,
        error: expect.objectContaining({
          message:
            "p: stream(request) must answer { textStream: AsyncIterable<string>, result: Promise<{ usage: { inputTokens, outputTokens }, cost?, finishReason? }> }",
        }),
      },
    });
    expect(breaker.told).toEqual([]);
  });

  it("a stream that fails mid-way and a result that settles with its partial usage: the call fails, once", async () => {
    const breaker = new Breaker();
    const cut = new ModelProviderFailureError({ failure: ModelFailure.NetworkError });
    const { answer } = await opened(
      () => ({
        textStream: chunks(["a", "b"], () => Promise.reject(cut)),
        result: Promise.resolve({ usage: { ...USAGE, outputTokens: 1 } }),
      }),
      breaker,
    );
    const told: string[] = [];

    const error = await settledError(
      answer.consume((text) => {
        told.push(text);
        return Promise.resolve();
      }),
    );

    expect(error).toBe(cut);
    expect(told).toEqual(["a", "b"]);
    expect(breaker.told).toEqual(["failure"]);
  });
});
