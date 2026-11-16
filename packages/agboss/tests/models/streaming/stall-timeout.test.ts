/**
 * #1125: the provider's `timeout` is a stall bound after the head too. A streamed answer that is
 * quiet for longer than it after its first content fails as a timeout (no retry — text is out, as a
 * cut stream), the clock counts between chunks, not the whole answer; a plain answer whose body
 * stalls after its headers times the attempt out and is retried; the room goes back either way.
 */
import { describe, expect, it } from "vitest";
import { InMemoryDatabase } from "../../../src/infrastructure/in-memory-database.js";
import { ModelFailure, RateLimitPolicy, RetryPolicy } from "../../../src/models/index.js";
import { StreamStalledError } from "../../../src/models/calls/event-stream-guard.js";
import { failureOfError } from "../../../src/models/model-failure.js";
import { resilientFetch } from "../../../src/models/resilient-fetch.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { seconds, type Milliseconds } from "../../../src/units/index.js";
import { milliseconds } from "../time.js";
import { instanceCalls } from "../gateway.js";
import { advanceUntil } from "../slow-provider.js";

const encoder = new TextEncoder();
const URL = "http://stall.test/v1/chat/completions";
const frame = (event: unknown): string =>
  `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`;
const delta = (content: string): string =>
  frame({ choices: [{ index: 0, delta: { content }, finish_reason: null }] });
const finish = frame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });

/** What the server does: write a part after a wait, or go quiet for good. */
type Step = { readonly after: number; readonly text: string } | "stall";

/** A fetch answering with a `text/event-stream` whose body plays `steps` on `clock`. */
function streamingFetch(
  clock: VirtualClock,
  steps: readonly Step[],
  seen: { calls: number; cancelled?: number },
) {
  const send: typeof fetch = () => {
    seen.calls += 1;
    const queue = [...steps];
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = queue.shift();
        if (next === undefined) {
          controller.close();
        } else if (next === "stall") {
          await new Promise<void>(() => undefined);
        } else {
          await clock.sleep(milliseconds(next.after));
          controller.enqueue(encoder.encode(next.text));
        }
      },
      cancel() {
        seen.cancelled = (seen.cancelled ?? 0) + 1;
      },
    });
    return Promise.resolve(
      new Response(body, { headers: { "content-type": "text/event-stream" } }),
    );
  };
  return send;
}

/** A fetch whose answers are plain JSON: the head at once, the body as each script says. */
function plainFetch(
  clock: VirtualClock,
  bodies: readonly string[], // "stall": the body never comes
  seen: { calls: number },
) {
  const send: typeof fetch = () => {
    const script = bodies[Math.min(seen.calls, bodies.length - 1)] ?? "{}";
    seen.calls += 1;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"id":'));
      },
      async pull(controller) {
        if (script === "stall") {
          await new Promise<void>(() => undefined);
        } else {
          await clock.sleep(milliseconds(1));
          controller.enqueue(encoder.encode(script.slice(6)));
          controller.close();
        }
      },
    });
    return Promise.resolve(
      new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
    );
  };
  return send;
}

const retryTimeouts = RetryPolicy.fixed({
  maxAttempts: 3,
  delay: milliseconds(0),
  retryOn: [ModelFailure.Timeout],
});

function clientOf(
  clock: VirtualClock,
  send: typeof fetch,
  extra: { readonly rooms?: number; readonly retry?: RetryPolicy; readonly opensAt?: number } = {},
) {
  const calls = instanceCalls(clock, new InMemoryDatabase(), "instance-1");
  const gate = calls.gateOf(
    "stall-provider",
    extra.rooms === undefined ? undefined : RateLimitPolicy.of({ maxConcurrentCalls: extra.rooms }),
  );
  const breaker = calls.breakerOf("stall-provider", {
    failureThreshold: extra.opensAt ?? 1000,
    window: seconds(600),
    openFor: seconds(600),
  });
  const fetchOf = resilientFetch(
    {
      provider: "stall-provider",
      timeout: seconds(20),
      retryPolicy: extra.retry ?? retryTimeouts,
      breaker,
      ...(gate === undefined ? {} : { gate }),
      clock,
    },
    send,
  );
  const call = async (): Promise<string> => {
    const response = await fetchOf(URL, { method: "POST", body: "{}" });
    return await response.text();
  };
  return { call, breaker };
}

const failureOf = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

describe("#1125 AC1: a streamed answer is bounded between its chunks", () => {
  it("a stream quiet for the timeout after its first content fails as a timeout, once, never retried; the breaker counts it", async () => {
    const clock = new VirtualClock();
    const seen: { calls: number; cancelled?: number } = { calls: 0 };
    const { call, breaker } = clientOf(
      clock,
      streamingFetch(clock, [{ after: 0, text: delta("One") }, "stall"], seen),
      { opensAt: 1 },
    );

    const failure = await advanceUntil(clock, failureOf(call()));

    expect(failure).toBeInstanceOf(StreamStalledError);
    expect((failure as Error).message).toBe("the model's stream stalled: no data for 20000 ms");
    expect(seen.cancelled).toBe(1); // the provider's connection is closed, not left open
    expect(failureOfError(failure)).toBe(ModelFailure.Timeout);
    expect(seen.calls).toBe(1); // text was out: no retry, as for a cut
    expect(await breaker.isOpen()).toBe(true); // one failure (threshold 1)
  });

  it("the clock counts between chunks, not the whole answer: 4 chunks 15 s apart under a 20 s timeout succeed", async () => {
    const clock = new VirtualClock();
    const seen = { calls: 0 };
    const gap = 15_000;
    const { call, breaker } = clientOf(
      clock,
      streamingFetch(
        clock,
        [
          { after: 0, text: delta("a") },
          { after: gap, text: delta("b") },
          { after: gap, text: delta("c") },
          { after: gap, text: delta("d") },
          { after: gap, text: finish + frame("[DONE]") },
        ],
        seen,
      ),
    );

    const text = await advanceUntil(clock, call());

    expect(text).toContain('"d"');
    expect(seen.calls).toBe(1);
    expect(await breaker.isOpen()).toBe(false);
  });

  it("every chunk's timer is let go once its read is over: no sleeper of the timeout is left running", async () => {
    const delays: { readonly signal: AbortSignal | undefined }[] = [];
    class RecordingClock extends VirtualClock {
      override sleep(delay: Milliseconds, signal?: AbortSignal): Promise<void> {
        if (delay === 20_000) delays.push({ signal });
        return super.sleep(delay, signal);
      }
    }
    const clock = new RecordingClock();
    const { call } = clientOf(
      clock,
      streamingFetch(
        clock,
        [
          { after: 1, text: delta("a") },
          { after: 1, text: delta("b") },
          { after: 1, text: finish + frame("[DONE]") },
        ],
        { calls: 0 },
      ),
    );

    await advanceUntil(clock, call());

    expect(delays.length).toBeGreaterThanOrEqual(3);
    expect(delays.every((sleep) => sleep.signal?.aborted === true)).toBe(true);
  });

  it("a gap just under the timeout passes, just over it fails", async () => {
    for (const [after, fails] of [
      [19_999, false],
      [20_001, true],
    ] as const) {
      const clock = new VirtualClock();
      const { call } = clientOf(
        clock,
        streamingFetch(
          clock,
          [
            { after: 0, text: delta("a") },
            { after, text: finish + frame("[DONE]") },
          ],
          { calls: 0 },
        ),
      );

      const outcome = await advanceUntil(clock, failureOf(call()), milliseconds(1), 30_000);

      expect(outcome instanceof StreamStalledError).toBe(fails);
    }
  });

  it("AC3: the rate-limit room is given back when a stream stalls: the next call is let in", async () => {
    const clock = new VirtualClock();
    const seen = { calls: 0 };
    const stalls = streamingFetch(clock, [{ after: 0, text: delta("One") }, "stall"], seen);
    const answers = streamingFetch(clock, [{ after: 0, text: finish + frame("[DONE]") }], seen);
    let first = true;
    const { call } = clientOf(
      clock,
      (input, init) => {
        const send = first ? stalls : answers;
        first = false;
        return send(input, init);
      },
      { rooms: 1 },
    );

    const stalled = failureOf(call());
    const next = call(); // waits for the only room
    const [failure, text] = await advanceUntil(clock, Promise.all([stalled, next]));

    expect(failure).toBeInstanceOf(StreamStalledError);
    expect(text).toContain("stop");
  });
});

describe("#1125 AC2: a plain call's body is under the attempt's timeout", () => {
  it("a body that stalls after the headers times the attempt out and is retried", async () => {
    const clock = new VirtualClock();
    const seen = { calls: 0 };
    const { call } = clientOf(clock, plainFetch(clock, ["stall", '{"id":"ok"}'], seen));

    const text = await advanceUntil(clock, call());

    expect(text).toBe('{"id":"ok"}');
    expect(seen.calls).toBe(2);
  });

  it("a body that always stalls fails as a timeout after the attempts, the room given back", async () => {
    const clock = new VirtualClock();
    const seen = { calls: 0 };
    const { call } = clientOf(clock, plainFetch(clock, ["stall"], seen), { rooms: 1 });

    const failure = await advanceUntil(clock, failureOf(call()), seconds(1), 200);
    const again = await advanceUntil(clock, failureOf(call()), seconds(1), 200);

    expect(failureOfError(failure)).toBe(ModelFailure.Timeout);
    expect(seen.calls).toBe(6); // 3 attempts each; the second call got the room
    expect(again).toBeDefined();
  });
});
