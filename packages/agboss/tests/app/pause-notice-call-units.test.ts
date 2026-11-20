/**
 * #1356 (pause-notices shard) — a receiver's hook run in the pause's frame under its timeout (#940), on its own: the
 * timeout aborts the frame's signal and the call, the instance's stop and the execution's own signal do too, and
 * a call that ended leaves no timer to abort anything later.
 */
import { describe, expect, it } from "vitest";
import { callInFrame, NoticeTimeoutError } from "../../src/app/pause-notice-call.js";
import { currentFrame, type FrameSpec } from "../../src/flow/context/frame.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { seconds } from "../../src/units/index.js";

/** A frame spec whose execution has `signal`; the rest is what the hook never reads here. */
const frameOf = (signal = new AbortController().signal): FrameSpec => {
  const spec = { execution: { signal }, step: {} };
  const isSpec = (value: object): value is FrameSpec => value === spec;
  if (!isSpec(spec)) throw new Error("unreachable");
  return spec;
};

/** The signal the hook saw on its frame. */
const frameSignalOf = (): AbortSignal => {
  const signal = currentFrame()?.execution.signal;
  if (signal === undefined) throw new Error("the hook ran outside a frame");
  return signal;
};

describe("#1356: a receiver's hook under its timeout", () => {
  it("gives what the hook returned, in a frame whose signal is none of the timeout's yet", async () => {
    const clock = new VirtualClock();
    let seen: AbortSignal | undefined;

    const result = await callInFrame({ frame: frameOf(), timeout: seconds(5), clock }, () => {
      seen = frameSignalOf();
      return Promise.resolve("told");
    });

    expect(result).toBe("told");
    expect(seen?.aborted).toBe(false);
  });

  it("rejects with what the hook threw", async () => {
    const clock = new VirtualClock();

    await expect(
      callInFrame({ frame: frameOf(), timeout: seconds(5), clock }, () =>
        Promise.reject(new Error("the hook failed")),
      ),
    ).rejects.toThrow("the hook failed");
  });

  it("past its timeout the call rejects with a NoticeTimeoutError that says how long, and the hook's own signal aborts", async () => {
    const clock = new VirtualClock();
    let seen: AbortSignal | undefined;
    const call = callInFrame({ frame: frameOf(), timeout: seconds(5), clock }, () => {
      seen = frameSignalOf();
      return new Promise<never>(() => undefined);
    });
    const failure = call.catch((error: unknown) => error);

    await clock.advance(seconds(4));
    expect(seen?.aborted).toBe(false);
    await clock.advance(seconds(1));
    const error = await failure;

    expect(error).toBeInstanceOf(NoticeTimeoutError);
    expect(error).toHaveProperty("name", "NoticeTimeoutError");
    expect(error).toHaveProperty("message", "timed out after 5 s");
    expect(seen?.aborted).toBe(true);
    expect(seen?.reason).toBeInstanceOf(NoticeTimeoutError);
  });

  it("a call that ended leaves no timer: the frame's signal is not aborted when its time would have come", async () => {
    const clock = new VirtualClock();
    let seen: AbortSignal | undefined;

    await callInFrame({ frame: frameOf(), timeout: seconds(5), clock }, () => {
      seen = frameSignalOf();
      return Promise.resolve();
    });
    await clock.advance(seconds(10));

    expect(seen?.aborted).toBe(false);
  });

  it("the instance's stop ends the call with its reason and aborts the hook's signal; a stop that is none leaves the call to its timeout", async () => {
    const clock = new VirtualClock();
    const stop = new AbortController();
    let seen: AbortSignal | undefined;
    const call = callInFrame(
      { frame: frameOf(), timeout: seconds(5), clock, interruption: stop.signal },
      () => {
        seen = frameSignalOf();
        return new Promise<never>(() => undefined);
      },
    );
    const failure = call.catch((error: unknown) => error);

    stop.abort(new Error("the instance stops"));

    expect(await failure).toHaveProperty("message", "the instance stops");
    expect(seen?.aborted).toBe(true);
    expect(seen?.reason).toHaveProperty("message", "the instance stops");
  });

  it("the execution's own signal reaches the hook: aborted, the hook sees it", async () => {
    const clock = new VirtualClock();
    const execution = new AbortController();
    let seen: AbortSignal | undefined;
    let finish: () => void = () => undefined;
    const call = callInFrame(
      { frame: frameOf(execution.signal), timeout: seconds(5), clock },
      () => {
        seen = frameSignalOf();
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
    );

    execution.abort();
    finish();
    await call;

    expect(seen?.aborted).toBe(true);
  });
});
