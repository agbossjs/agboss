/** #1008 AC1: a subscriber's queue coalesces the deltas of one step and is bounded. */
import { describe, expect, it } from "vitest";
import {
  droppedLog,
  listenerOf,
  SubscriberQueue,
  SUBSCRIBER_CHUNK_CHARS,
  SUBSCRIBER_MAX_BYTES,
  SUBSCRIBER_MAX_EVENTS,
} from "../../../src/a2a/server/a2a-subscriber-queue.js";
import { InMemoryA2ATaskRepository } from "../../../src/infrastructure/in-memory-a2a-task.repository.js";
import { InMemoryDatabase } from "../../../src/infrastructure/in-memory-database.js";
import type { ExecutionStreamEvent, StreamStep } from "../../../src/run/types.js";
import { savedTask, scriptOf, unitParts, WORKING } from "./support/unit-parts.js";

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

describe("#1048: what makes two deltas one step", () => {
  it.each([
    ["the agent", { agent: "other-agent" }],
    ["the visit", { visit: 2 }],
    ["the branch", { branch: "execution-2" }],
    ["the attempt", { attempt: 2 }],
  ] as const)("a delta of another %s is a chunk of its own", (_name, change) => {
    const queue = new SubscriberQueue();

    queue.push({ kind: "textDelta", delta: "a", step: STEP });
    queue.push({ kind: "textDelta", delta: "b", step: { ...STEP, ...change } });

    expect(queue.take().map((event) => (event.kind === "textDelta" ? event.delta : ""))).toEqual([
      "a",
      "b",
    ]);
  });

  it("a delta after a tool call or a retraction of the same step is a chunk of its own", () => {
    const queue = new SubscriberQueue();

    queue.push({ kind: "discarded", step: STEP, reason: "tool-turn" });
    queue.push({ kind: "textDelta", delta: "a", step: STEP });
    queue.push({ kind: "toolCall", tool: "t" });
    queue.push({ kind: "textDelta", delta: "b", step: STEP });

    expect(queue.take()).toHaveLength(4);
  });

  it("the first event of an empty queue starts it, and a queue waits only while empty and in", () => {
    const queue = new SubscriberQueue();
    expect(queue.isWaiting).toBe(true);

    queue.push({ kind: "toolCall", tool: "t" });
    expect(queue.isWaiting).toBe(false);
    queue.take();

    expect(queue.isWaiting).toBe(true);
  });
});

describe("#1048: listenerOf", () => {
  it("queues each event and wakes the reader; a drop is told once and the reader still woken", () => {
    const queue = new SubscriberQueue();
    const told: string[] = [];
    const listen = listenerOf(
      queue,
      () => told.push("wake"),
      () => told.push("drop"),
    );

    listen({ kind: "toolCall", tool: "t" });
    listen({ kind: "textDelta", delta: "x".repeat(SUBSCRIBER_MAX_BYTES + 1), step: STEP }); // behind: dropped
    listen({ kind: "toolCall", tool: "t" }); // dropped: heard no more

    expect(told).toEqual(["wake", "drop", "wake"]);
    expect(queue.isDropped).toBe(true);
    expect(queue.take()).toEqual([]);
  });
});

describe("#1048: droppedLog", () => {
  it("warns once with the task's ids and no text", async () => {
    const script = scriptOf();
    const tasks = new InMemoryA2ATaskRepository(new InMemoryDatabase());
    const task = await savedTask(tasks, { skill: "unit-workflow-start" }, WORKING);

    droppedLog(unitParts(script, tasks), task)();

    expect(script.warnings).toEqual([
      `stream.subscriber-dropped a stream subscriber of task ${task.taskId} fell too far behind and was ended; the task goes on ${JSON.stringify({ executionId: task.taskId, tenantId: task.tenantId })}`,
    ]);
  });
});

const textOf = (events: readonly ExecutionStreamEvent[]): string[] =>
  events.map((event) => (event.kind === "textDelta" ? event.delta : ""));

describe("#1140: a single large delta never drops a reader that is keeping up", () => {
  it("a delta over the byte bound, found by an empty queue, is taken as chunks that join to it", () => {
    const queue = new SubscriberQueue();
    const big = "ab".repeat(SUBSCRIBER_MAX_BYTES); // 2 MiB

    expect(queue.push({ kind: "textDelta", delta: big, step: STEP })).toBe(true);

    expect(queue.isDropped).toBe(false);
    const taken = textOf(queue.take());
    expect(taken.every((piece) => piece.length <= SUBSCRIBER_CHUNK_CHARS)).toBe(true);
    expect(taken.length).toBe(Math.ceil(big.length / SUBSCRIBER_CHUNK_CHARS));
    expect(taken.join("")).toBe(big);
  });

  it("then the next one is taken too, once the reader took the first", () => {
    const queue = new SubscriberQueue();
    const big = "x".repeat(2 * SUBSCRIBER_MAX_BYTES);

    expect(queue.push({ kind: "textDelta", delta: big, step: STEP })).toBe(true);
    queue.take();
    expect(queue.push({ kind: "textDelta", delta: big, step: STEP })).toBe(true);
    expect(queue.isDropped).toBe(false);
  });

  it("a reader already behind (something waiting) that gets a delta over the bound is dropped", () => {
    const queue = new SubscriberQueue();
    queue.push({ kind: "toolCall", tool: "t" });

    expect(
      queue.push({ kind: "textDelta", delta: "x".repeat(SUBSCRIBER_MAX_BYTES + 1), step: STEP }),
    ).toBe(false);
    expect(queue.isDropped).toBe(true);
  });

  it("a chunk never cuts a surrogate pair, whichever side of the cut it falls on", () => {
    for (const lead of [SUBSCRIBER_CHUNK_CHARS - 1, SUBSCRIBER_CHUNK_CHARS - 2]) {
      const queue = new SubscriberQueue();
      const text = `${"a".repeat(lead)}😀${"b".repeat(5)}`;

      queue.push({ kind: "textDelta", delta: text, step: STEP });
      const taken = textOf(queue.take());

      expect(taken.join("")).toBe(text);
      for (const piece of taken) {
        expect(piece.length).toBeLessThanOrEqual(SUBSCRIBER_CHUNK_CHARS);
        expect(piece).toBe(Buffer.from(piece, "utf8").toString("utf8")); // no lone surrogate
      }
    }
  });

  it("the first and the last high surrogate are kept with their low one too", () => {
    for (const pair of ["\ud800\udc00", "\udbff\udfff"]) {
      const queue = new SubscriberQueue();
      const text = `${"a".repeat(SUBSCRIBER_CHUNK_CHARS - 1)}${pair}${"b".repeat(3)}`;

      queue.push({ kind: "textDelta", delta: text, step: STEP });
      const taken = textOf(queue.take());

      expect(taken.map((piece) => piece.length)).toEqual([SUBSCRIBER_CHUNK_CHARS - 1, 5]);
      expect(taken.join("")).toBe(text);
    }
  });

  it("a high surrogate that ends the whole text stays in its chunk: nothing follows to pair with", () => {
    const queue = new SubscriberQueue();
    const text = `${"a".repeat(SUBSCRIBER_CHUNK_CHARS - 1)}\ud83d`;

    queue.push({ kind: "textDelta", delta: text, step: STEP });

    expect(textOf(queue.take())).toEqual([text]);
  });

  it("deltas of one step join only while they fit one chunk", () => {
    const queue = new SubscriberQueue();
    const half = "x".repeat(SUBSCRIBER_CHUNK_CHARS / 2);

    queue.push({ kind: "textDelta", delta: half, step: STEP });
    queue.push({ kind: "textDelta", delta: half, step: STEP }); // exactly one chunk: joined
    queue.push({ kind: "textDelta", delta: "y", step: STEP }); // over it: a chunk of its own

    expect(textOf(queue.take()).map((piece) => piece.length)).toEqual([SUBSCRIBER_CHUNK_CHARS, 1]);
  });

  it("an empty delta stays one (empty) event; a delta of exactly one chunk is not split", () => {
    const queue = new SubscriberQueue();

    queue.push({ kind: "textDelta", delta: "x".repeat(SUBSCRIBER_CHUNK_CHARS), step: OTHER });
    queue.push({ kind: "toolCall", tool: "t" });
    queue.push({ kind: "textDelta", delta: "", step: STEP });

    expect(textOf(queue.take()).map((piece) => piece.length)).toEqual([
      SUBSCRIBER_CHUNK_CHARS,
      0,
      0,
    ]);
  });
});
