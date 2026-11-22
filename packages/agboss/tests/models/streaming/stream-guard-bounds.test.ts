/**
 * #1366 (stream shard) — the bounds of a streamed answer's guard, each on its own: how much is read waiting for the
 * first content (a megabyte, the megabyte itself still read through) before the client gets the stream as it is, what
 * a body that ends without content says, and the stall bound of the body after it — counted on the clock from the
 * last data, never restarted by a comment, and a caller's own abort told apart from the provider's failure.
 */
import { describe, expect, it, vi } from "vitest";
import {
  EventStreamError,
  guardedEventStream,
  peek,
  StreamStalledError,
  type Watch,
} from "../../../src/models/calls/event-stream-guard.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import type { Milliseconds } from "../../../src/units/index.js";

const encoder = new TextEncoder();
const MOST_PEEKED = 1_048_576;
const comment = (bytes: number): Uint8Array => encoder.encode(`:${"p".repeat(bytes - 2)}\n`);
const frame = (event: unknown): Uint8Array => encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
const content = frame({ choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] });
const failed = frame({ error: { message: "overloaded", code: 529 } });

const responseOf = (chunks: readonly Uint8Array[]): Response =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );

const watching = (changes: Partial<Watch> = {}): Watch & { settle: ReturnType<typeof vi.fn> } => {
  const settle = vi.fn((_end: string) => Promise.resolve());
  return { settle, aborted: () => false, ...changes } as never;
};

describe("#1366: what is read waiting for the first content", () => {
  it("reads through up to a megabyte of what is no content, and a failure after it is the attempt's own", async () => {
    const guarded = await guardedEventStream(
      responseOf([comment(MOST_PEEKED), failed]),
      watching(),
    );

    expect(guarded.failure).toBeDefined();
    expect(guarded.watched).toBe(false);
  });

  it("past a megabyte the client gets the stream as it is: what follows is watched, no failure of the attempt", async () => {
    const guarded = await guardedEventStream(
      responseOf([comment(MOST_PEEKED + 1), failed]),
      watching(),
    );

    expect(guarded.failure).toBeUndefined();
    expect(guarded.watched).toBe(true);
  });

  it("adds each chunk to what was read: a megabyte in two parts is a megabyte", async () => {
    const half = MOST_PEEKED / 2;

    const within = await guardedEventStream(
      responseOf([comment(half), comment(half), failed]),
      watching(),
    );
    const beyond = await guardedEventStream(
      responseOf([comment(half), comment(half + 1), failed]),
      watching(),
    );

    expect(within.failure).toBeDefined();
    expect(beyond.failure).toBeUndefined();
  });

  it("is told, past the bound, as content: the bytes read and that signal", async () => {
    const reader = responseOf([comment(MOST_PEEKED + 1)]).body?.getReader();

    const peeked = await peek(reader as never);

    expect(peeked.signal).toEqual({ kind: "content" });
    expect(peeked.read).toHaveLength(1);
  });

  it("a body that ends with no content at all is an EventStreamError of its own name", async () => {
    const failure = await guardedEventStream(responseOf([comment(10)]), watching()).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(EventStreamError);
    expect(failure).toMatchObject({
      name: "EventStreamError",
      message: "the stream ended before any content",
    });
  });
});

describe("#1366: the stall bound of a body after its first content", () => {
  const TIMEOUT = 1000 as Milliseconds;

  /** A body of `steps` on `clock`: after each wait a chunk, or no more for good. */
  function stalledBody(
    clock: VirtualClock,
    steps: readonly (readonly [number, Uint8Array] | "stall")[],
  ) {
    const queue = [...steps];
    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          const next = queue.shift();
          if (next === undefined) controller.close();
          else if (next === "stall") await new Promise<void>(() => undefined);
          else {
            if (next[0] > 0) await clock.sleep(next[0] as Milliseconds);
            controller.enqueue(next[1]);
          }
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  }

  /** Reads the guarded body in the background; what it ended with once the clock is at `at` ms. */
  async function endOfReadAt(
    steps: readonly (readonly [number, Uint8Array] | "stall")[],
    advances: readonly number[],
    first: readonly Uint8Array[] = [content],
    isStallAdded = false,
  ) {
    const clock = new VirtualClock();
    const watch = watching({ idle: { clock, timeout: TIMEOUT } });
    const opening = first.map((chunk) => [0, chunk] as const);
    const all = [...opening, ...steps, ...(isStallAdded ? (["stall"] as const) : [])];
    const guarded = await guardedEventStream(stalledBody(clock, all), watch);
    const reader = guarded.response.body?.getReader();
    const outcomes: string[] = [];
    const reading = (async () => {
      try {
        for (;;) {
          const { done } = await (reader as ReadableStreamDefaultReader<Uint8Array>).read();
          if (done) {
            outcomes.push("done");
            return;
          }
        }
      } catch (error) {
        outcomes.push(
          error instanceof StreamStalledError ? `stalled ${String(error.idle)}` : "other",
        );
      }
    })();
    const seen: string[][] = [];
    for (const ms of advances) {
      await clock.advance(ms as Milliseconds);
      await new Promise((resolve) => setTimeout(resolve, 5));
      seen.push([...outcomes]);
    }
    return { seen, watch, reading };
  }

  it("is the provider's timeout of no data: a body quiet for that long fails, and not a moment before", async () => {
    const { seen, watch } = await endOfReadAt(["stall"], [999, 1]);

    expect(seen[0]).toEqual([]);
    expect(seen[1]).toEqual(["stalled 1000"]);
    expect(watch.settle).toHaveBeenCalledExactlyOnceWith("failed");
  });

  it("a comment is no progress: the bound is counted from the last data, not restarted by it", async () => {
    const { seen } = await endOfReadAt(
      [[600, encoder.encode(": keep-alive\n\n")], "stall"],
      [999, 1],
    );

    expect(seen[0]).toEqual([]);
    expect(seen[1]).toEqual(["stalled 1000"]);
  });

  it("data restarts it: a chunk of content after 600 ms leaves the whole bound again", async () => {
    const { seen } = await endOfReadAt([[600, content], "stall"], [600, 999, 1]);

    expect(seen[0]).toEqual([]);
    expect(seen[1]).toEqual([]);
    expect(seen[2]).toEqual(["stalled 1000"]);
  });

  it("counts from the start when what was read before it brought no data: a megabyte of comments, then silence", async () => {
    const { seen } = await endOfReadAt([], [999, 1], [comment(MOST_PEEKED + 1)], true);

    expect(seen[0]).toEqual([]);
    expect(seen[1]).toEqual(["stalled 1000"]);
  });

  it("a body of a failed attempt that breaks while it is read fails with its own error, with no watcher to tell", async () => {
    const boom = new Error("connection reset");
    let sent = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent) controller.error(boom);
          else controller.enqueue(failed);
          sent = true;
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );

    const guarded = await guardedEventStream(response, watching());
    const reader = guarded.response.body?.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    await reader.read();

    expect(guarded.watched).toBe(false);
    await expect(reader.read()).rejects.toBe(boom);
  });

  it("a caller that aborted is not a failure of the provider: its body error is told as ignored", async () => {
    const clock = new VirtualClock();
    const watch = watching({ idle: { clock, timeout: TIMEOUT }, aborted: () => true });
    const guarded = await guardedEventStream(stalledBody(clock, [[0, content], "stall"]), watch);
    const reader = guarded.response.body?.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    await reader.read();
    const stalled = reader.read().catch((error: unknown) => error);

    await clock.advance(TIMEOUT);

    expect(await stalled).toBeInstanceOf(StreamStalledError);
    expect(watch.settle).toHaveBeenCalledExactlyOnceWith("ignored");
  });
});
