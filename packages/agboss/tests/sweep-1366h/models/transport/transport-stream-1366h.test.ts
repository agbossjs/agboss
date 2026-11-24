/**
 * #1366: a streamed transport call — a chunk that is no string and a stream of the wrong shape are
 * the project's bugs (a rejected attempt, the breaker not told); the SDK's iterator is closed after
 * a failure; the attempt's abort reaches the request's signal (also when already aborted); the
 * caller's abort ends a stalled read at once, and is not a wait that ran out; every timeout timer
 * is released; a failed read releases what its usage settles to unless the wait ran out; the
 * answer has no `cost` / `finishReason` key unless the usage had one.
 */
import { describe, expect, it } from "vitest";
import {
  ModelCallError,
  ModelProviderError,
  ModelProviderFailureError,
  ModelProviderInputError,
  type ModelProviderRequest,
  type ModelProviderStream,
} from "../../../../src/models/index.js";
import { PromptCaching } from "../../../../src/models/prompt-caching.js";
import { Reasoning } from "../../../../src/models/reasoning.js";
import { transportStreamCarrier } from "../../../../src/models/transport/transport-stream.js";
import { VirtualClock } from "../../../../src/testing/clock.js";
import type { Milliseconds } from "../../../../src/units/index.js";
import { seconds } from "../../../../src/units/index.js";

const REQUEST: Omit<ModelProviderRequest, "signal"> = {
  model: "m",
  messages: [],
  tools: [],
  temperature: 0,
  maxTokens: undefined,
  reasoning: Reasoning.off(),
  promptCaching: PromptCaching.off(),
};

const never = (): Promise<never> => new Promise<never>(() => undefined);
const tick = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 5));

/** The timers' signals of the clock: a timeout that was not released stays unaborted. */
class SpyClock extends VirtualClock {
  readonly signals: (AbortSignal | undefined)[] = [];
  override sleep(delay: Milliseconds, signal?: AbortSignal): Promise<void> {
    this.signals.push(signal);
    return super.sleep(delay, signal);
  }
}

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

/** A stream of `steps` (a string is a chunk, a function a step that runs), its `return` counted. */
function iterated(steps: readonly (string | (() => Promise<never>))[]) {
  const returned = { count: 0 };
  let at = 0;
  const textStream: AsyncIterable<string> = {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        const step = steps[at++];
        if (step === undefined) return { done: true, value: undefined };
        if (typeof step === "function") return await step();
        return { done: false, value: step };
      },
      return: () => {
        returned.count += 1;
        return Promise.resolve({ done: true, value: undefined });
      },
    }),
  };
  return { textStream, returned };
}

interface Opened {
  readonly carrier: ReturnType<typeof transportStreamCarrier>;
  readonly clock: SpyClock;
  readonly breaker: Breaker;
  readonly seen: AbortSignal[];
}

function carrierOf(
  source: (request: ModelProviderRequest) => ModelProviderStream,
  caller?: AbortSignal,
): Opened {
  const clock = new SpyClock();
  const breaker = new Breaker();
  const seen: AbortSignal[] = [];
  const carrier = transportStreamCarrier(
    (request) => {
      seen.push(request.signal);
      return source(request);
    },
    REQUEST,
    caller,
    { provider: "p", clock, timeout: seconds(5), breaker },
  );
  return { carrier, clock, breaker, seen };
}

const sendOn = (opened: Opened, signal: AbortSignal = new AbortController().signal) =>
  opened.carrier.send(signal, { gate: undefined, timeout: seconds(5), clock: opened.clock });

/** Opens, holds the room into `released`, and returns the answer. */
async function held(opened: Opened) {
  const attempt = await sendOn(opened);
  if (attempt.kind !== "answered") throw new Error("not answered", { cause: attempt });
  const released: number[] = [];
  const answer = opened.carrier.hold(attempt.answer, (tokens) => {
    released.push(tokens);
    return Promise.resolve();
  });
  return { answer, released };
}

const settledError = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

const USAGE = { inputTokens: 7, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };

describe("#1366: a stream that breaks the transport's contract is the project's bug", () => {
  it("a first chunk that is no string is a rejected attempt with a ModelProviderError", async () => {
    const bad: AsyncIterable<string> = {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.resolve({ done: false, value: 42 as never }),
      }),
    };

    const attempt = await sendOn(
      carrierOf(() => ({ textStream: bad, result: Promise.resolve({ usage: USAGE }) })),
    );

    expect(attempt).toMatchObject({ kind: "threw", isRejected: true });
    expect(attempt.kind === "threw" && attempt.error).toBeInstanceOf(ModelProviderError);
  });

  it("a later chunk that is no string rejects with it, tells the breaker nothing, releases the usage", async () => {
    let at = 0;
    const bad: AsyncIterable<string> = {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          at += 1;
          return Promise.resolve(
            at === 1
              ? { done: false, value: "a" }
              : at === 2
                ? { done: false, value: 7 as never }
                : { done: true, value: undefined },
          );
        },
      }),
    };
    const opened = carrierOf(() => ({
      textStream: bad,
      result: Promise.resolve({ usage: USAGE }),
    }));
    const { answer, released } = await held(opened);

    const error = await settledError(answer.consume(() => Promise.resolve()));

    expect(error).toBeInstanceOf(ModelProviderError);
    expect(opened.breaker.told).toEqual([]);
    expect(released).toEqual([12]);
  });

  it("a stream of the wrong shape is a rejected attempt, not a failure to retry", async () => {
    const attempt = await sendOn(carrierOf(() => ({}) as never));

    expect(attempt).toMatchObject({ kind: "threw", isRejected: true });
    expect(attempt.kind === "threw" && attempt.error).toBeInstanceOf(ModelProviderError);
  });

  it("a part the SDK cannot take is a rejected attempt with a ModelCallError naming provider and model", async () => {
    const refusal = new ModelProviderInputError({ kind: "image", mediaType: "image/png" });
    const attempt = await sendOn(
      carrierOf(() => {
        throw refusal;
      }),
    );

    expect(attempt).toMatchObject({ kind: "threw", isRejected: true });
    const error = attempt.kind === "threw" ? attempt.error : undefined;
    expect(error).toBeInstanceOf(ModelCallError);
    expect(error).toMatchObject({
      code: "model.unsupported-input",
      provider: "p",
      model: "m",
      kind: "image",
      mediaType: "image/png",
    });
  });

  it("an error of the SDK after the caller aborted is thrown as it is", async () => {
    const caller = new AbortController();
    caller.abort(new Error("caller left"));
    const boom = new Error("boom");

    const failed = sendOn(
      carrierOf(() => {
        throw boom;
      }, caller.signal),
    );

    await expect(failed).rejects.toBe(boom);
  });
});

describe("#1366: the SDK's iterator is closed after a failure", () => {
  it("a failure before the first chunk closes it", async () => {
    const { textStream, returned } = iterated([() => Promise.reject(new Error("no chunk"))]);

    const attempt = await sendOn(
      carrierOf(() => ({ textStream, result: Promise.resolve({ usage: USAGE }) })),
    );
    await tick();

    expect(attempt.kind).toBe("threw");
    expect(returned.count).toBe(1);
  });

  it("a read that fails after the first chunk closes it", async () => {
    const { textStream, returned } = iterated(["a", () => Promise.reject(new Error("cut"))]);
    const { answer } = await held(
      carrierOf(() => ({ textStream, result: Promise.resolve({ usage: USAGE }) })),
    );

    await settledError(answer.consume(() => Promise.resolve()));
    await tick();

    expect(returned.count).toBe(1);
  });
});

describe("#1366: the attempt's abort reaches the request's signal", () => {
  it("an abort after the stream opened aborts the request with the same reason, not before", async () => {
    const { textStream } = iterated(["a", never]);
    const opened = carrierOf(() => ({ textStream, result: Promise.resolve({ usage: USAGE }) }));
    const attempt = new AbortController();
    const reason = new Error("attempt over");

    await sendOn(opened, attempt.signal);
    const request = opened.seen[0];
    const abortedBefore = request?.aborted;
    attempt.abort(reason);

    expect(abortedBefore).toBe(false);
    expect(request?.aborted).toBe(true);
    expect(request?.reason).toBe(reason);
  });

  it("an attempt already aborted opens the stream with an aborted request signal", async () => {
    const { textStream } = iterated(["a"]);
    const opened = carrierOf(() => ({ textStream, result: Promise.resolve({ usage: USAGE }) }));
    const attempt = new AbortController();
    const reason = new Error("already over");
    attempt.abort(reason);

    await settledError(sendOn(opened, attempt.signal));

    expect(opened.seen[0]?.aborted).toBe(true);
    expect(opened.seen[0]?.reason).toBe(reason);
  });
});

describe("#1366: the caller's abort and the wait that ran out", () => {
  it("the caller's abort ends a stalled read at once, with its own reason", async () => {
    const caller = new AbortController();
    const { textStream } = iterated(["a", never]);
    const opened = carrierOf(
      () => ({ textStream, result: Promise.resolve({ usage: USAGE }) }),
      caller.signal,
    );
    const { answer, released } = await held(opened);
    let end: unknown = "pending";
    const consumed = answer
      .consume(() => Promise.resolve())
      .then(
        () => {
          end = "answered";
        },
        (error: unknown) => {
          end = error;
        },
      );
    await tick();
    const reason = new Error("caller left");

    caller.abort(reason);
    await consumed;

    expect(end).toBe(reason);
    expect(released).toEqual([0]);
    expect(opened.breaker.told).toEqual([]);
  });

  it("a caller's abort whose reason is a TimeoutError is still the caller's, not a typed timeout", async () => {
    const caller = new AbortController();
    const { textStream } = iterated(["a", never]);
    const { answer } = await held(
      carrierOf(() => ({ textStream, result: Promise.resolve({ usage: USAGE }) }), caller.signal),
    );
    const consumed = settledError(answer.consume(() => Promise.resolve()));
    await tick();
    const reason = new DOMException("the caller's own deadline", "TimeoutError");

    caller.abort(reason);

    expect(await consumed).toBe(reason);
  });

  it("a wait that ran out with a live caller releases none and is a typed timeout", async () => {
    const caller = new AbortController();
    const { textStream } = iterated(["a", never]);
    const opened = carrierOf(
      () => ({ textStream, result: Promise.resolve({ usage: USAGE }) }),
      caller.signal,
    );
    const { answer, released } = await held(opened);

    const consumed = settledError(answer.consume(() => Promise.resolve()));
    await opened.clock.advance(seconds(6));
    const error = await consumed;

    expect(error).toBeInstanceOf(ModelProviderFailureError);
    expect(released).toEqual([0]);
    expect(opened.breaker.told).toEqual(["failure"]);
  });

  it("a read that fails with a live caller releases what its usage settles to", async () => {
    const caller = new AbortController();
    const { textStream } = iterated(["a", () => Promise.reject(new Error("cut"))]);
    const { answer, released } = await held(
      carrierOf(() => ({ textStream, result: Promise.resolve({ usage: USAGE }) }), caller.signal),
    );

    await settledError(answer.consume(() => Promise.resolve()));

    expect(released).toEqual([12]);
  });

  it("an error that is no timeout is thrown as it is", async () => {
    const cut = new Error("cut");
    const { textStream } = iterated(["a", () => Promise.reject(cut)]);
    const { answer } = await held(
      carrierOf(() => ({ textStream, result: Promise.resolve({ usage: USAGE }) })),
    );

    const error = await settledError(answer.consume(() => Promise.resolve()));

    expect(error).toBe(cut);
  });

  it("a timeout of the SDK itself (a TimeoutError it throws) is the typed timeout", async () => {
    const own = new DOMException("sdk timed out", "TimeoutError");
    const { textStream } = iterated(["a", () => Promise.reject(own)]);
    const { answer } = await held(
      carrierOf(() => ({ textStream, result: Promise.resolve({ usage: USAGE }) })),
    );

    const error = await settledError(answer.consume(() => Promise.resolve()));

    expect(error).toBeInstanceOf(ModelProviderFailureError);
  });
});

describe("#1366: every timeout timer of a read is released", () => {
  it("none is left running after a completed stream", async () => {
    const { textStream } = iterated(["a", "b"]);
    const opened = carrierOf(() => ({ textStream, result: Promise.resolve({ usage: USAGE }) }));
    const { answer } = await held(opened);

    await answer.consume(() => Promise.resolve());
    await tick();

    expect(opened.clock.signals.length).toBeGreaterThan(0);
    expect(opened.clock.signals.every((signal) => signal?.aborted === true)).toBe(true);
  });
});

describe("#1366: the answer has only the fields the usage had", () => {
  it("no cost and no finishReason key when the usage has none", async () => {
    const { textStream } = iterated(["a"]);
    const { answer } = await held(
      carrierOf(() => ({ textStream, result: Promise.resolve({ usage: USAGE }) })),
    );

    const response = await answer.consume(() => Promise.resolve());

    expect(Object.keys(response).sort()).toEqual(["text", "usage"]);
  });
});
