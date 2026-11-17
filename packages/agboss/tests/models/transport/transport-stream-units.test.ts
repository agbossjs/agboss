import { describe, expect, it } from "vitest";
import {
  FinishReason,
  ModelFailure,
  ModelProviderFailureError,
} from "../../../src/models/index.js";
import { transportStreamCarrier } from "../../../src/models/transport/transport-stream.js";
import type { StreamedAnswer } from "../../../src/models/transport/transport-stream.js";
import type { ModelProviderRequest, ModelProviderStream } from "../../../src/models/index.js";
import { Reasoning } from "../../../src/models/reasoning.js";
import { PromptCaching } from "../../../src/models/prompt-caching.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { seconds, usd } from "../../../src/units/index.js";

/** #1011: the streamed carrier's end — what the breaker is told, and that a failed stream is stopped. */

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
  it("the usage's cost and finishReason are the response's, as complete()'s are", async () => {
    const { answer } = await opened(
      () => ({
        textStream: chunks(["cut"]),
        usage: Promise.resolve({
          inputTokens: 1,
          outputTokens: 2,
          cost: usd(0.5),
          finishReason: FinishReason.Length,
        }),
      }),
      new Breaker(),
    );

    const response = await answer.consume(() => Promise.resolve());

    expect(response).toEqual({
      text: "cut",
      usage: { inputTokens: 1, outputTokens: 2 },
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
        usage: Promise.reject(failure),
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
        usage: Promise.resolve({ inputTokens: 1, outputTokens: 2 }),
      }),
      breaker,
    );

    const response = await answer.consume(() => Promise.resolve());

    expect(response).toEqual({ text: "ab", usage: { inputTokens: 1, outputTokens: 2 } });
    expect(breaker.told).toEqual(["success"]);
  });

  it("a stalled stream is one failure, typed, and the SDK is told to stop", async () => {
    const breaker = new Breaker();
    const never = (): Promise<void> => new Promise<void>(() => undefined);
    const { answer, clock, seen } = await opened(
      () => ({ textStream: chunks(["a"], never), usage: new Promise(() => undefined) }),
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
