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
async function peek(
  reader: Reader,
): Promise<{ readonly read: Uint8Array[]; readonly signal: StreamSignal | undefined }> {
  const scanner = new EventScanner();
  const read: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { read, signal: undefined };
    read.push(value);
    size += value.byteLength;
    const [signal] = scanner.push(value);
    if (signal !== undefined) return { read, signal };
    if (size > MOST_PEEKED) return { read, signal: { kind: "content" } };
  }
}

/** The body: what was read, then the rest; the watcher's `onChunk` / `onEnd` see every chunk and the end. */
function replayed(
  reader: Reader,
  read: readonly Uint8Array[],
  watch: Watch | undefined,
): ReadableStream<Uint8Array> {
  const queue = [...read];
  const scanner = new EventScanner();
  let ended = false;
  let told = false;
  const tell = async (end: StreamEnd): Promise<void> => {
    if (told || watch === undefined) return;
    told = true;
    await watch.settle(end);
  };
  const seen = async (chunk: Uint8Array): Promise<void> => {
    for (const signal of scanner.push(chunk)) {
      if (signal.kind === "end") ended = true;
      if (signal.kind === "error") await tell(signal.failure === undefined ? "ignored" : "failed");
    }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = queue.shift();
        const { done, value } =
          next === undefined ? await reader.read() : { done: false, value: next };
        if (done) {
          await tell(ended ? "completed" : "failed");
          if (ended || watch === undefined) controller.close();
          else controller.error(new EventStreamError("the stream ended before it was complete"));
          return;
        }
        await seen(value);
        controller.enqueue(value);
      } catch (error) {
        await tell(watch?.aborted() === true ? "ignored" : "failed");
        controller.error(error);
      }
    },
    async cancel(reason) {
      await tell(ended ? "completed" : "ignored");
      await reader.cancel(reason);
    },
  });
}

/** What watches a guarded body to its end. */
export interface Watch {
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
