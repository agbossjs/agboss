import type { A2ATaskRecord } from "../../infrastructure/a2a-task.repository.js";
import { StreamEventKind, type ExecutionStreamEvent, type StreamStep } from "../../run/types.js";
import type { A2AServerParts } from "./a2a-server-parts.js";
import { kilobytes, type Bytes } from "../../units/index.js";

/**
 * What one stream subscriber has not been sent yet (#1008). A run never waits for its readers, so a
 * reader that is slow lets events pile up here: a text delta joins the delta before it when both
 * are of one step (one pending chunk, nothing lost for the reader), and past the bound the
 * subscriber is dropped — its queue is cleared and it hears no more. Memory per subscriber is
 * bounded by `SUBSCRIBER_MAX_BYTES` of text plus `SUBSCRIBER_MAX_EVENTS` small events, plus the one
 * event that arrived: an event that finds nothing waiting is always taken (#1140), so a single delta
 * larger than the bound — a transport provider's whole answer — never drops a reader that is keeping
 * up. A delta larger than `SUBSCRIBER_CHUNK_CHARS` is queued as chunks of at most that many characters
 * (a code point is never cut), and two deltas of one step are joined only up to that size, so no frame
 * the reader writes is larger than a chunk.
 */

/** Events a subscriber may have waiting. */
export const SUBSCRIBER_MAX_EVENTS = 1000;

/** Text, in bytes, a subscriber may have waiting. */
export const SUBSCRIBER_MAX_BYTES: Bytes = kilobytes(1024);

/** The most characters (UTF-16 units) of one queued chunk of text. */
export const SUBSCRIBER_CHUNK_CHARS = 16_384;

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;

/** `text` as pieces of at most `SUBSCRIBER_CHUNK_CHARS`, none cutting a surrogate pair. */
function piecesOf(text: string): string[] {
  const pieces: string[] = [];
  for (let from = 0; from < text.length;) {
    let to = Math.min(from + SUBSCRIBER_CHUNK_CHARS, text.length);
    if (to < text.length && isHighSurrogate(text.charCodeAt(to - 1))) to -= 1;
    pieces.push(text.slice(from, to));
    from = to;
  }
  return pieces.length === 0 ? [text] : pieces;
}

const textBytesOf = (event: ExecutionStreamEvent): number =>
  event.kind === StreamEventKind.TextDelta ? Buffer.byteLength(event.delta) : 0;

const sameStep = (left: StreamStep, right: StreamStep): boolean =>
  left.agent === right.agent &&
  left.visit === right.visit &&
  left.branch === right.branch &&
  left.attempt === right.attempt;

/** A subscriber's bounded queue. */
export class SubscriberQueue {
  #events: ExecutionStreamEvent[] = [];
  #size = 0;
  #dropped = false;

  /** Whether the subscriber went over its bound: it is dropped, and takes no more. */
  get isDropped(): boolean {
    return this.#dropped;
  }

  /** Whether nothing waits and the subscriber is still in: the reader may sleep until a change. */
  get isWaiting(): boolean {
    return !this.#dropped && this.#events.length === 0;
  }

  /** Queues `event`; returns `false` when this made the subscriber exceed its bound (dropped). */
  push(event: ExecutionStreamEvent): boolean {
    if (this.#dropped) return false;
    const waiting = this.#events.length;
    if (event.kind === StreamEventKind.TextDelta) {
      for (const delta of piecesOf(event.delta)) this.#addText({ ...event, delta });
    } else {
      this.#events.push(event);
    }
    this.#size += textBytesOf(event);
    // an event that found nothing waiting is the reader's to take, however large (#1140)
    const behind =
      waiting > 0 &&
      (this.#size > SUBSCRIBER_MAX_BYTES || this.#events.length > SUBSCRIBER_MAX_EVENTS);
    if (behind) {
      this.#dropped = true;
      this.#events = [];
      this.#size = 0;
      return false;
    }
    return true;
  }

  /** One chunk of text: joined to the chunk before when that is of its step and both fit one chunk. */
  #addText(event: ExecutionStreamEvent & { readonly kind: StreamEventKind.TextDelta }): void {
    const last = this.#events.at(-1);
    if (
      last?.kind === StreamEventKind.TextDelta &&
      sameStep(last.step, event.step) &&
      last.delta.length + event.delta.length <= SUBSCRIBER_CHUNK_CHARS
    ) {
      this.#events[this.#events.length - 1] = { ...event, delta: last.delta + event.delta };
    } else {
      this.#events.push(event);
    }
  }

  /** Everything waiting, in order; the queue is empty after. */
  take(): ExecutionStreamEvent[] {
    const taken = this.#events;
    this.#events = [];
    this.#size = 0;
    return taken;
  }
}

/** What a subscriber hears a run with: each event is queued and wakes the reader; the drop calls `onDrop`. */
export const listenerOf =
  (queue: SubscriberQueue, wake: () => void, onDrop: () => void) =>
  (event: ExecutionStreamEvent): void => {
    if (queue.isDropped) return;
    if (!queue.push(event)) onDrop();
    wake();
  };

/** What a subscriber too far behind ends with: a clean close, the task goes on; said once, no text. */
export const droppedLog = (parts: Pick<A2AServerParts, "log">, task: A2ATaskRecord) => (): void => {
  parts.log.warn(
    "stream.subscriber-dropped",
    `a stream subscriber of task ${task.taskId} fell too far behind and was ended; the task goes on`,
    { executionId: task.taskId, tenantId: task.tenantId },
  );
};
