/** #1008 AC1: a subscriber's queue coalesces the deltas of one step and is bounded. */
import { describe, expect, it } from "vitest";
import {
  SubscriberQueue,
  SUBSCRIBER_MAX_BYTES,
  SUBSCRIBER_MAX_EVENTS,
} from "../../../src/a2a/server/a2a-subscriber-queue.js";
import type { StreamStep } from "../../../src/run/types.js";

const STEP: StreamStep = { agent: "desk-agent", visit: 1, branch: "execution-1", attempt: 1 };
const OTHER: StreamStep = { ...STEP, attempt: 2 };

describe("#1008: the subscriber queue", () => {
  it("adjacent deltas of one step become one chunk; another step, a tool call and a retraction stay apart", () => {
    const queue = new SubscriberQueue();
    queue.push({ kind: "textDelta", delta: "he", step: STEP });
    queue.push({ kind: "textDelta", delta: "llo", step: STEP });
    queue.push({ kind: "toolCall", tool: "lookup-tool" });
    queue.push({ kind: "textDelta", delta: "a", step: STEP });
    queue.push({ kind: "textDelta", delta: "b", step: OTHER });
    queue.push({ kind: "discarded", step: OTHER, reason: "judge-rejected" });

    expect(queue.take()).toStrictEqual([
      { kind: "textDelta", delta: "hello", step: STEP },
      { kind: "toolCall", tool: "lookup-tool" },
      { kind: "textDelta", delta: "a", step: STEP },
      { kind: "textDelta", delta: "b", step: OTHER },
      { kind: "discarded", step: OTHER, reason: "judge-rejected" },
    ]);
    expect(queue.isWaiting).toBe(true);
  });

  it("over the byte bound the subscriber is dropped: queue cleared, no more taken", () => {
    const queue = new SubscriberQueue();
    const half = "x".repeat(SUBSCRIBER_MAX_BYTES / 2);

    expect(queue.push({ kind: "textDelta", delta: half, step: STEP })).toBe(true);
    expect(queue.push({ kind: "textDelta", delta: half, step: STEP })).toBe(true);
    expect(queue.push({ kind: "textDelta", delta: "x", step: STEP })).toBe(false);

    expect(queue.isDropped).toBe(true);
    expect(queue.take()).toStrictEqual([]);
    expect(queue.push({ kind: "toolCall", tool: "t" })).toBe(false);
  });

  it("bytes are counted, not characters; over the event bound the subscriber is dropped", () => {
    const wide = new SubscriberQueue();
    expect(
      wide.push({ kind: "textDelta", delta: "é".repeat(SUBSCRIBER_MAX_BYTES / 2), step: STEP }),
    ).toBe(true);
    expect(wide.push({ kind: "textDelta", delta: "é", step: STEP })).toBe(false);

    const many = new SubscriberQueue();
    for (let index = 0; index < SUBSCRIBER_MAX_EVENTS; index += 1) {
      expect(many.push({ kind: "toolCall", tool: "t" })).toBe(true);
    }
    expect(many.push({ kind: "toolCall", tool: "t" })).toBe(false);
  });
});
