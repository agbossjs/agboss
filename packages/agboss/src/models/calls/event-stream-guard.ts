import { timeoutOn, type Clock } from "../../infrastructure/clock.js";
import type { Milliseconds } from "../../units/index.js";
import type { ModelFailure } from "../model-failure.js";
import { EventScanner, type StreamSignal } from "./event-stream.js";

/**
 * A streamed answer's guard (#1005). Before the response reaches the client it is read up to its
 * first content: an `{error}` or a cut there is a failed attempt the retry policy may retry — no
 * text has gone out yet. After that the body is watched to its end and the call's fate is told once
 * (`settle`): complete, failed (an `{error}`, a broken or an unfinished body), or ignored (the
 * caller's abort, a client error). A failed stream is never a success with a partial answer.
 */

/** How a streamed call ended, as told to its breaker. */
export type StreamEnd = "completed" | "failed" | "ignored";

/** A stream that ended before it said it was complete, or said it failed. */
export class EventStreamError extends Error {
  override name = "EventStreamError";
}

/**
 * A streamed answer that went quiet for longer than the provider's `timeout` after its first
 * content (#1125). Named `TimeoutError`, so it reads as `ModelFailure.Timeout`.
 */
export class StreamStalledError extends Error {
  override name = "TimeoutError";

  constructor(readonly idle: Milliseconds) {
    super(`the model's stream stalled: no data for ${String(idle)} ms`);
  }
}

/** The most that is read waiting for the first content before the client gets the stream as it is. */
const MOST_PEEKED = 1_048_576;

/** What the guard made of a response. */
export interface GuardedStream {
  readonly response: Response;
  /** The attempt failed before any content (an `{error}`); retryable under the retry policy. */
  readonly failure?: ModelFailure | undefined;
  /** The body is watched: its end is told to `settle`, so the caller must not count it earlier. */
  readonly watched: boolean;
}

type Reader = ReadableStreamDefaultReader<Uint8Array>;

const asResponse = (source: Response, body: ReadableStream<Uint8Array>): Response =>
  new Response(body, {
    status: source.status,
    statusText: source.statusText,
    headers: source.headers,
  });

/** Reads until the first signal; the bytes read and that signal (`undefined`: the body ended without one). */
export async function peek(
  reader: Reader,
): Promise<{ readonly read: Uint8Array[]; readonly signal: StreamSignal | undefined }> {
  const scanner = new EventScanner();
  const read: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { read, signal: scanner.finish()[0] };
    read.push(value);
    size += value.byteLength;
    const [signal] = scanner.push(value);
    if (signal !== undefined) return { read, signal };
    if (size > MOST_PEEKED) return { read, signal: { kind: "content" } };
  }
}

/** How long the body has been quiet: waiting for the provider since the last progress (#1125). */
interface Quiet {
  waited: number;
}

/**
 * One read of the body under the stall bound: the idle timer counts only while this waits for the
 * provider, and a read that brings no progress (a `:` comment) does not restart it: what is left of
 * the bound is what `quiet` has not used.
 */
async function readWithin(
  reader: Reader,
  idle: Idle | undefined,
  quiet: Quiet,
): Promise<Awaited<ReturnType<Reader["read"]>>> {
  if (idle === undefined) return await reader.read();
  const left = idle.timeout - quiet.waited;
  const stall = (): StreamStalledError => new StreamStalledError(idle.timeout);
  const timer = timeoutOn(idle.clock, Math.max(0, left) as Milliseconds, stall);
  const stalled = new Promise<never>((_resolve, reject) => {
    timer.signal.addEventListener("abort", () => {
      reject(timer.signal.reason as StreamStalledError); // what the timer aborted with, made above
    });
  });
  const startedAt = idle.clock.monotonicNow();
  try {
    const result = await Promise.race([reader.read(), stalled]);
    quiet.waited += idle.clock.monotonicNow() - startedAt;
    return result;
  } catch (error) {
    // a stalled provider's connection is closed; on a body that failed by itself it is a no-op
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    timer.release();
  }
}

/** What reads a guarded body's signals: whether it said it was complete, and the call's fate told once. */
function trackerOf(watch: Watch | undefined, quiet: Quiet) {
  const scanner = new EventScanner();
  let ended = false;
  let told = false;
  const tell = async (end: StreamEnd): Promise<void> => {
    if (told || watch === undefined) return;
    told = true;
    await watch.settle(end);
  };
  const react = async (signals: readonly StreamSignal[]): Promise<void> => {
    for (const signal of signals) {
      if (signal.kind === "end") ended = true;
      if (signal.kind === "error") await tell(signal.failure === undefined ? "ignored" : "failed");
    }
  };
  return {
    tell,
    isEnded: () => ended,
    async seen(chunk: Uint8Array): Promise<void> {
      const signals = scanner.push(chunk);
      if (scanner.progressed) quiet.waited = 0; // only data restarts the stall bound; a comment does not
      await react(signals);
    },
    // a last event the server ended with one line end, or none (#1329)
    finished: () => react(scanner.finish()),
  };
}

/** The body: what was read, then the rest; the watcher's `onChunk` / `onEnd` see every chunk and the end. */
function replayed(
  reader: Reader,
  read: readonly Uint8Array[],
  watch: Watch | undefined,
): ReadableStream<Uint8Array> {
  const queue = [...read];
  const quiet: Quiet = { waited: 0 };
  const track = trackerOf(watch, quiet);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = queue.shift();
        const { done, value } =
          next === undefined
            ? await readWithin(reader, watch?.idle, quiet)
            : { done: false, value: next };
        if (done) {
          await track.finished();
          await track.tell(track.isEnded() ? "completed" : "failed");
          if (track.isEnded() || watch === undefined) controller.close();
          else controller.error(new EventStreamError("the stream ended before it was complete"));
          return;
        }
        await track.seen(value);
        controller.enqueue(value);
      } catch (error) {
        await track.tell(watch?.aborted() === true ? "ignored" : "failed");
        controller.error(error);
      }
    },
    async cancel(reason) {
      await track.tell(track.isEnded() ? "completed" : "ignored");
      await reader.cancel(reason);
    },
  });
}

/** The longest a streamed answer may be quiet between two chunks (#1125), counted on the clock. */
export interface Idle {
  readonly clock: Clock;
  readonly timeout: Milliseconds;
}

/** What watches a guarded body to its end. */
export interface Watch {
  /** The stall bound of the body after its first content; none = unbounded (the head's timeout ended). */
  readonly idle?: Idle;
  readonly settle: (end: StreamEnd) => Promise<void>;
  /** Whether the caller's own signal aborted (its body error is then not the provider's). */
  readonly aborted: () => boolean;
}

/**
 * The response of a `text/event-stream` answer, guarded. Throws what reading the first content
 * throws (a broken body: the attempt's own failure) and an `EventStreamError` for a body that ended
 * without any content.
 */
export async function guardedEventStream(response: Response, watch: Watch): Promise<GuardedStream> {
  const body = response.body;
  if (body === null) return { response, watched: false };
  const reader = body.getReader();
  const { read, signal } = await peek(reader);
  if (signal === undefined) {
    throw new EventStreamError("the stream ended before any content");
  }
  if (signal.kind === "error") {
    const failed = asResponse(response, replayed(reader, read, undefined));
    return { response: failed, failure: signal.failure, watched: false };
  }
  return { response: asResponse(response, replayed(reader, read, watch)), watched: true };
}
