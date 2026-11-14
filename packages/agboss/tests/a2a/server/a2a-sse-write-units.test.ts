/** #1048: the SSE writer's units — a socket that took the write, drained, closed, failed or went silent. */
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import {
  KEEP_ALIVE_COMMENT,
  nextWithKeepAlive,
  SSE_DRAIN_TIMEOUT,
  SSE_KEEP_ALIVE,
  writeSse,
} from "../../../src/a2a/server/a2a-sse-write.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import type { Milliseconds } from "../../../src/units/index.js";

/** A response whose socket takes `accepts` writes or says it is full; what it was given is kept. */
class Response extends ServerResponse {
  readonly written: string[] = [];
  accepts = true;
  constructor() {
    super(new IncomingMessage(new Socket()));
  }
  override write(chunk: string): boolean {
    this.written.push(chunk);
    return this.accepts;
  }
}

/** A clock that keeps the signals of the sleeps it was asked for. */
class RecordingClock extends VirtualClock {
  readonly signals: (AbortSignal | undefined)[] = [];
  override sleep(delay: Milliseconds, signal?: AbortSignal): Promise<void> {
    this.signals.push(signal);
    return super.sleep(delay, signal);
  }
}

const EVENTS = ["drain", "close", "error"] as const;
const listenersOf = (res: Response): number[] => EVENTS.map((event) => res.listenerCount(event));

describe("writeSse", () => {
  it("writes to a live response and is done when the socket took it", async () => {
    const res = new Response();

    expect(await writeSse(res, "data: 1\n\n", new VirtualClock())).toBe(true);
    expect(res.written).toEqual(["data: 1\n\n"]);
  });

  it("writes nothing to a destroyed response", async () => {
    const res = new Response();
    res.destroy();

    expect(await writeSse(res, "x", new VirtualClock())).toBe(false);
    expect(res.written).toEqual([]);
  });

  it("writes nothing to an ended response", async () => {
    const res = new Response();
    res.end();

    expect(await writeSse(res, "x", new VirtualClock())).toBe(false);
    expect(res.written).toEqual([]);
  });

  it("a full socket is waited for until it drains, and no listener stays behind", async () => {
    const res = new Response();
    res.accepts = false;
    const before = listenersOf(res);
    const clock = new RecordingClock();

    const pending = writeSse(res, "x", clock);
    expect(listenersOf(res)).toEqual(before.map((count) => count + 1));
    res.emit("drain");

    expect(await pending).toBe(true);
    expect(listenersOf(res)).toEqual(before);
    expect(clock.signals[0]?.aborted).toBe(true); // the drain timer is cancelled
    expect(res.destroyed).toBe(false);
  });

  it("a connection that closes while waiting ends the writes", async () => {
    const res = new Response();
    res.accepts = false;
    const pending = writeSse(res, "x", new VirtualClock());

    res.destroy();
    res.emit("close"); // a response with no real socket says so itself

    expect(await pending).toBe(false);
  });

  it("a socket that fails while waiting is not a cut one: the response is left as it was", async () => {
    const res = new Response();
    res.accepts = false;
    const before = listenersOf(res);
    const pending = writeSse(res, "x", new VirtualClock());

    res.emit("error", new Error("EPIPE"));

    expect(await pending).toBe(true);
    expect(listenersOf(res)).toEqual(before);
    expect(res.destroyed).toBe(false);
  });

  it("a reader that takes nothing for the drain timeout is cut", async () => {
    const res = new Response();
    res.accepts = false;
    const clock = new VirtualClock();
    const pending = writeSse(res, "x", clock);

    await clock.advance(SSE_DRAIN_TIMEOUT);

    expect(await pending).toBe(false);
    expect(res.destroyed).toBe(true);
  });

  it("a reader that drains just before the timeout is not cut", async () => {
    const res = new Response();
    res.accepts = false;
    const clock = new VirtualClock();
    const pending = writeSse(res, "x", clock);

    await clock.advance("59999ms");
    res.emit("drain");

    expect(await pending).toBe(true);
    expect(res.destroyed).toBe(false);
  });
});

describe("nextWithKeepAlive", () => {
  it("is the pending value when it comes first, with the idle timer cancelled", async () => {
    const res = new Response();
    const clock = new RecordingClock();

    const value = await nextWithKeepAlive(res, Promise.resolve("event"), clock);

    expect(value).toBe("event");
    expect(res.written).toEqual([]);
    expect(clock.signals[0]?.aborted).toBe(true);
  });

  it("writes a keep-alive comment for each idle interval, then returns the value", async () => {
    const res = new Response();
    const clock = new VirtualClock();
    let arrive = (_value: string): void => undefined;
    const pending = new Promise<string>((resolve) => (arrive = resolve));
    const next = nextWithKeepAlive(res, pending, clock);

    await clock.advance("14999ms");
    expect(res.written).toEqual([]);
    await clock.advance("1ms");
    await clock.advance(SSE_KEEP_ALIVE);
    expect(res.written).toEqual([KEEP_ALIVE_COMMENT, KEEP_ALIVE_COMMENT]);
    arrive("late");

    expect(await next).toBe("late");
  });

  it("ends with nothing when the connection is gone at a keep-alive", async () => {
    const res = new Response();
    const clock = new VirtualClock();
    const next = nextWithKeepAlive(res, new Promise<string>(() => undefined), clock);
    res.destroy();

    await clock.advance(SSE_KEEP_ALIVE);

    expect(await next).toBeUndefined();
  });

  it("a value that is falsy is still the value", async () => {
    const value = await nextWithKeepAlive(new Response(), Promise.resolve(0), new VirtualClock());

    expect(value).toBe(0);
  });
});
