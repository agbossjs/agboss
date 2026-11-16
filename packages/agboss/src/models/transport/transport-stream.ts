import { timeoutError, timeoutOn, type Clock } from "../../infrastructure/clock.js";
import type { Milliseconds } from "../../units/index.js";
import type { Attempt, AttemptCarrier } from "../calls/model-call.js";
import type { CircuitBreaker } from "../circuit-breaker.js";
import { ModelFailure } from "../model-failure.js";
import { ModelProviderError } from "../model-provider.decorator.js";
import { ModelProviderFailureError } from "./failure-error.js";
import { sourceOf } from "./transport-stream-source.js";
import { failedAttempt, tokensOf, untilAborted } from "./transport-carrier.js";
import type {
  ModelProviderRequest,
  ModelProviderResponse,
  ModelProviderStream,
  ModelProviderUsage,
} from "./transport.js";

/**
 * A transport's streamed call (#1011): `stream(request)` through the one attempt runner, as
 * `complete(request)` goes (transport-carrier.ts). The attempt reads up to the first chunk — a failure
 * before it is the attempt's, the retry policy's to retry, no text has gone out. After it the text
 * is read as it comes (`consume`), each wait bound by the provider's `timeout`, and the call's fate
 * is told to the breaker once, at the end: completed (the stream ended and its usage settled), failed
 * (it threw, went silent or its usage did not settle), ignored (the caller's abort, a project's bug).
 * A failed stream is never a success with a partial answer.
 */

/** A provider's `stream`, its instance bound. */
export type TransportStreamCall = (request: ModelProviderRequest) => ModelProviderStream;

/** How a streamed call ends: the text is told to `onText`, the answer is the plain call's. */
export interface StreamedAnswer {
  readonly consume: (onText: (text: string) => Promise<void>) => Promise<ModelProviderResponse>;
  /** The same answer, the rate-limit room released with its real tokens once it is used up. */
  readonly withRelease: (release: (tokens: number) => Promise<void>) => StreamedAnswer;
}

/** What a streamed call's waits and end run under. */
export interface StreamLimits {
  readonly provider: string;
  readonly clock: Clock;
  /** The provider's `timeout`: the longest wait for a chunk, and for the usage after the last one. */
  readonly timeout: Milliseconds;
  readonly breaker: Pick<CircuitBreaker, "recordSuccess" | "recordFailure"> | undefined;
}

const nothing = (): void => undefined;

type Pull = IteratorResult<string>;

/** `work`, ended by the provider's timeout on the clock and by `caller` (the call's own signal). */
async function within<T>(
  work: Promise<T>,
  limits: StreamLimits,
  caller: AbortSignal | undefined,
): Promise<T> {
  work.catch(nothing); // an already aborted caller never reads it: its late failure is not unhandled
  const timer = timeoutOn(limits.clock, limits.timeout, timeoutError);
  const signals = [timer.signal, ...(caller === undefined ? [] : [caller])];
  try {
    return await untilAborted(work, AbortSignal.any(signals));
  } finally {
    timer.release();
  }
}

/** The stream's source closed (its generator told to stop); never throws, never awaited. */
function closeQuietly(iterator: AsyncIterator<string>): void {
  void Promise.resolve()
    .then(() => iterator.return?.())
    .catch(nothing);
}

const notAString = (provider: string): ModelProviderError =>
  new ModelProviderError({
    message: `${provider}: stream(request).textStream must yield strings`,
  });

/** A chunk of the text, checked: it is the project's code. */
function textOf(pulled: Pull, provider: string): string | undefined {
  if (pulled.done === true) return undefined;
  const value: unknown = pulled.value;
  if (typeof value !== "string") throw notAString(provider);
  return value;
}

/** What a stream's end means to the breaker. */
type End = "completed" | "failed" | "ignored";

interface Reading {
  readonly iterator: AsyncIterator<string>;
  readonly first: Pull;
  readonly usage: Promise<ModelProviderUsage>;
  readonly caller: AbortSignal | undefined;
  readonly limits: StreamLimits;
  /** Tells the SDK to stop (the request's signal): a stream that failed or stalled is not left open. */
  readonly stop: (reason: unknown) => void;
}

/** The error of a failed read: a wait that ran out is a typed timeout, anything else as it is. */
function surfaced(error: unknown, reading: Reading): unknown {
  if (reading.caller?.aborted === true) return error;
  const isTimeout = error instanceof Error && error.name === "TimeoutError";
  return isTimeout
    ? new ModelProviderFailureError({ failure: ModelFailure.Timeout, cause: error })
    : error;
}

type Release = ((tokens: number) => Promise<void>) | undefined;

/** The end is told to the breaker: a success and a failure once each, an ignored end never. */
async function tell(limits: StreamLimits, end: End): Promise<void> {
  if (end === "completed") await limits.breaker?.recordSuccess();
  if (end === "failed") await limits.breaker?.recordFailure();
}

/** What the call used, as far as its usage settles in time; never throws. */
async function usedAfterFailure(reading: Reading): Promise<number> {
  try {
    const usage = await within(reading.usage, reading.limits, reading.caller);
    return tokensOf({ text: "", usage });
  } catch {
    return 0;
  }
}

/** How a failed read ends: a project's bug or the caller's abort is no failure of the provider. */
function endOf(error: unknown, caller: AbortSignal | undefined): End {
  return error instanceof ModelProviderError || caller?.aborted === true ? "ignored" : "failed";
}

/**
 * A failed read ends the call: the SDK is told to stop, the breaker is told, the room is released
 * (with the tokens its usage settles to, unless the wait itself ran out) and the error is thrown.
 */
async function failWith(
  reading: Reading,
  release: Release,
  error: unknown,
  isUsageWaited: boolean,
): Promise<never> {
  reading.stop(error);
  closeQuietly(reading.iterator);
  await tell(reading.limits, endOf(error, reading.caller));
  await release?.(isUsageWaited ? await usedAfterFailure(reading) : 0);
  throw surfaced(error, reading);
}

/** The text of the stream after its first chunk, each chunk told to `onText`. */
async function readText(
  reading: Reading,
  onText: (text: string) => Promise<void>,
): Promise<string> {
  const { limits, caller } = reading;
  let text = "";
  let pulled = reading.first;
  for (let chunk = textOf(pulled, limits.provider); chunk !== undefined;) {
    text += chunk;
    await onText(chunk);
    pulled = await within(reading.iterator.next(), limits, caller);
    chunk = textOf(pulled, limits.provider);
  }
  return text;
}

/** Whether the error is a wait that ran out (the caller's abort is not). */
const isRanOut = (error: unknown, caller: AbortSignal | undefined): boolean =>
  error instanceof Error && error.name === "TimeoutError" && caller?.aborted !== true;

function answerOf(reading: Reading, release: Release): StreamedAnswer {
  const { limits, caller } = reading;
  return {
    withRelease: (next) => answerOf(reading, next),
    consume: async (onText) => {
      let text: string;
      try {
        text = await readText(reading, onText);
      } catch (error) {
        const isWaited = !isRanOut(error, caller) && caller?.aborted !== true;
        return await failWith(reading, release, error, isWaited);
      }
      let usage: ModelProviderUsage;
      try {
        usage = await within(reading.usage, limits, caller);
      } catch (error) {
        return await failWith(reading, release, error, false);
      }
      await tell(limits, "completed");
      await release?.(tokensOf({ text, usage }));
      return { text, usage };
    },
  };
}

/**
 * A streamed request as the attempts' carrier: each attempt opens `stream()` with the attempt's
 * signal and reads its first chunk; the answer is the rest of the stream, read by `consume`.
 */
export function transportStreamCarrier(
  stream: TransportStreamCall,
  request: Omit<ModelProviderRequest, "signal">,
  caller: AbortSignal | undefined,
  limits: StreamLimits,
): AttemptCarrier<StreamedAnswer> {
  return {
    send: async (signal): Promise<Attempt<StreamedAnswer>> => {
      let iterator: AsyncIterator<string> | undefined;
      try {
        const controller = new AbortController();
        const forward = (): void => {
          controller.abort(signal.reason);
        };
        if (signal.aborted) forward();
        else signal.addEventListener("abort", forward, { once: true });
        const source = sourceOf(stream({ ...request, signal: controller.signal }), limits.provider);
        source.usage.catch(nothing); // read at the end; a failed attempt never reads it
        iterator = source.textStream[Symbol.asyncIterator]();
        const first = await untilAborted(iterator.next(), signal);
        textOf(first, limits.provider);
        const answer = answerOf(
          {
            iterator,
            first,
            usage: source.usage,
            caller,
            limits,
            stop: (reason) => {
              controller.abort(reason);
            },
          },
          undefined,
        );
        return { kind: "answered", answer, settledAtEnd: true };
      } catch (error) {
        if (iterator !== undefined) closeQuietly(iterator);
        if (caller?.aborted === true) throw error;
        if (error instanceof ModelProviderError) return { kind: "threw", error, isRejected: true };
        return failedAttempt(error, signal, { provider: limits.provider, model: request.model });
      }
    },
    hold: (answer, release) => answer.withRelease(release),
    drop: () => Promise.resolve(),
  };
}
