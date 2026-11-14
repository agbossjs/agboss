import { runInFrame, type FrameSpec } from "../flow/context/frame.js";
import { timeoutOn, type Clock } from "../infrastructure/clock.js";
import type { Milliseconds } from "../units/index.js";

/**
 * A receiver told of a pause's notice (#940): its hook runs in the pause's execution frame (its
 * `ExecutionContext`: tenant, fields, the waiting step) under a timeout on the application's clock
 * — its `executionContext.signal` aborts then — and the call ends when the hook does or the
 * timeout passes, whichever comes first. Loaded with the first notice.
 */

/** A receiver's hook that ran past its timeout. */
export class NoticeTimeoutError extends Error {
  override name = "NoticeTimeoutError";

  constructor(timeout: Milliseconds) {
    super(`timed out after ${String(timeout / 1000)} s`);
  }
}

/** Rejects when `signal` aborts, even if the work ignores it. */
function untilAborted(work: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => {
      reject(signal.reason as Error);
    });
    work.then(resolve, reject);
  });
}

/** The frame with the timeout's signal on its execution. */
const withSignal = (frame: FrameSpec, signal: AbortSignal): FrameSpec => ({
  ...frame,
  execution: Object.freeze({
    ...frame.execution,
    signal: AbortSignal.any([frame.execution.signal, signal]),
  }),
});

/** Where a hook runs and how long it may take. */
export interface NoticeCall {
  readonly frame: FrameSpec;
  readonly timeout: Milliseconds;
  readonly clock: Clock;
  /** The instance's interruption: a stop that ends its deliveries (the claim lapses, another instance delivers). */
  readonly interruption?: AbortSignal | undefined;
}

/** Runs `hook` in the frame under the timeout; rejects with what it threw or `NoticeTimeoutError`. */
export async function callInFrame(call: NoticeCall, hook: () => Promise<void>): Promise<void> {
  const timer = timeoutOn(call.clock, call.timeout, () => new NoticeTimeoutError(call.timeout));
  const ends = AbortSignal.any([timer.signal, ...(call.interruption ? [call.interruption] : [])]);
  try {
    await untilAborted(runInFrame(withSignal(call.frame, ends), hook), ends);
  } finally {
    timer.release();
  }
}
