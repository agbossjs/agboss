import type { A2ATaskRecord } from "../../infrastructure/a2a-task.repository.js";
import type { ExecutionStreamEvent } from "../../run/types.js";
import type { A2AServerParts } from "./a2a-server-parts.js";
import { kilobytes, type Bytes } from "../../units/index.js";

/**
 * What one stream subscriber has not been sent yet (#1008). A run never waits for its readers, so a
 * reader that is slow lets events pile up here: a text delta joins the delta before it when both
 * are of one step (one pending chunk, nothing lost for the reader), and past the bound the
 * subscriber is dropped — its queue is cleared and it hears no more. Memory per subscriber is
 * bounded by `SUBSCRIBER_MAX_BYTES` of text plus `SUBSCRIBER_MAX_EVENTS` small events.
 */

/** Events a subscriber may have waiting. */
export const SUBSCRIBER_MAX_EVENTS = 1000;

/** Text, in bytes, a subscriber may have waiting. */
export const SUBSCRIBER_MAX_BYTES: Bytes = kilobytes(1024);

const textBytesOf = (event: ExecutionStreamEvent): number =>
  event.kind === "textDelta" ? Buffer.byteLength(event.delta, "utf8") : 0;

const sameStep = (left: ExecutionStreamEvent, right: ExecutionStreamEvent): boolean =>
  left.kind === "textDelta" &&
  right.kind === "textDelta" &&
  left.step.agent === right.step.agent &&
  left.step.visit === right.step.visit &&
  left.step.branch === right.step.branch &&
  left.step.attempt === right.step.attempt;

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
    const last = this.#events.at(-1);
    if (last !== undefined && event.kind === "textDelta" && sameStep(last, event)) {
      this.#events[this.#events.length - 1] = { ...event, delta: textOf(last) + event.delta };
    } else {
      this.#events.push(event);
    }
    this.#size += textBytesOf(event);
    if (this.#size > SUBSCRIBER_MAX_BYTES || this.#events.length > SUBSCRIBER_MAX_EVENTS) {
      this.#dropped = true;
      this.#events = [];
      this.#size = 0;
      return false;
    }
    return true;
  }

  /** Everything waiting, in order; the queue is empty after. */
  take(): ExecutionStreamEvent[] {
    const taken = this.#events;
    this.#events = [];
    this.#size = 0;
    return taken;
  }
}

const textOf = (event: ExecutionStreamEvent): string =>
  event.kind === "textDelta" ? event.delta : "";

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
