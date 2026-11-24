/**
 * #1366: the tokens a streamed transport call releases to the provider's per-minute window — the
 * result's input plus output once the stream ended; after a failed read what its result's usage
 * settles to (#1311), and none when the wait itself ran out or the result never came.
 */
import { describe, expect, it } from "vitest";
import type { ModelProviderRequest, ModelProviderStream } from "../../../src/models/index.js";
import { PromptCaching } from "../../../src/models/prompt-caching.js";
import { Reasoning } from "../../../src/models/reasoning.js";
import { transportStreamCarrier } from "../../../src/models/transport/transport-stream.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { seconds } from "../../../src/units/index.js";

const REQUEST: Omit<ModelProviderRequest, "signal"> = {
  model: "m",
  messages: [],
  tools: [],
  temperature: 0,
  maxTokens: undefined,
  reasoning: Reasoning.off(),
  promptCaching: PromptCaching.off(),
};

async function* chunks(parts: readonly string[], then?: () => Promise<void>) {
  for (const part of parts) yield part;
  await then?.();
}

const never = (): Promise<never> => new Promise<never>(() => undefined);

const USAGE = { inputTokens: 7, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** The answer of `source`, its room released into `released` (the tokens each release gave). */
async function held(source: () => ModelProviderStream) {
  const clock = new VirtualClock();
  const released: number[] = [];
  const carrier = transportStreamCarrier(source, REQUEST, undefined, {
    provider: "p",
    clock,
    timeout: seconds(5),
    breaker: undefined,
  });
  const attempt = await carrier.send(new AbortController().signal, {
    gate: undefined,
    timeout: seconds(5),
    clock,
  });
  if (attempt.kind !== "answered") throw new Error("not answered", { cause: attempt });
  const answer = carrier.hold(attempt.answer, (tokens) => {
    released.push(tokens);
    return Promise.resolve();
  });
  return { answer, clock, released };
}

const settled = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

describe("#1366: the tokens a streamed call releases", () => {
  it("a stream that ends well releases its input and output tokens, once", async () => {
    const { answer, released } = await held(() => ({
      textStream: chunks(["a", "b"]),
      result: Promise.resolve({ usage: USAGE }),
    }));

    await answer.consume(() => Promise.resolve());

    expect(released).toEqual([12]);
  });

  it("a read that fails releases what its result's usage settles to", async () => {
    const { answer, released } = await held(() => ({
      textStream: chunks(["a"], () => Promise.reject(new Error("the stream broke"))),
      result: Promise.resolve({ usage: USAGE }),
    }));

    const error = await settled(answer.consume(() => Promise.resolve()));

    expect(error).toBeInstanceOf(Error);
    expect(released).toEqual([12]);
  });

  it("a read that fails with no result coming releases none", async () => {
    const { answer, released } = await held(() => ({
      textStream: chunks(["a"], () => Promise.reject(new Error("the stream broke"))),
      result: Promise.reject(new Error("no result")),
    }));

    await settled(answer.consume(() => Promise.resolve()));

    expect(released).toEqual([0]);
  });

  it("a wait that ran out releases none, though the result would have counted", async () => {
    const { answer, clock, released } = await held(() => ({
      textStream: chunks(["a"], never),
      result: Promise.resolve({ usage: USAGE }),
    }));

    const consumed = settled(answer.consume(() => Promise.resolve()));
    await clock.advance(seconds(6));
    await consumed;

    expect(released).toEqual([0]);
  });

  it("a result that never settles after the text releases none", async () => {
    const { answer, clock, released } = await held(() => ({
      textStream: chunks(["a"]),
      result: never(),
    }));

    const consumed = settled(answer.consume(() => Promise.resolve()));
    await clock.advance(seconds(6));
    await consumed;

    expect(released).toEqual([0]);
  });
});
