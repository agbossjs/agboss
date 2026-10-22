import { runInFrame, type FrameSpec } from "../flow/context/frame.js";
import { timeoutOn } from "../infrastructure/clock-timeout.js";
import type { Clock } from "../infrastructure/clock.js";
import type { FrameworkLog } from "../infrastructure/logger.js";
import type { PauseCancellation, PauseRecord } from "../infrastructure/pause-record.js";
import type { Milliseconds } from "../units/index.js";
import type { ChannelSender } from "./channel-sender.js";

/**
 * A channel told that a pause it sent closed without an answer (#337): its `withdraw` runs once, in
 * the pause's execution frame (its `ExecutionContext`: tenant, fields, the waiting step), under the
 * tool's `timeout` on the application's clock — its `executionContext.signal` aborts then. A throw
 * or a timeout is a warning in the log (`channel.withdraw-failed`) and nothing else: the join, the
 * side path or the cancel that closed the pause goes on. Loaded with the first withdrawal.
 */

/** The log code of a `withdraw` that threw or ran past its timeout. */
export const WITHDRAW_FAILED = "channel.withdraw-failed";

/** One channel told: its sender, the pause, why it closed, and where `withdraw` runs. */
export interface ChannelWithdrawalCall {
  readonly channel: string;
  readonly sender: ChannelSender;
  readonly pause: PauseRecord;
  readonly resolution: PauseCancellation;
  readonly frame: FrameSpec;
  readonly timeout: Milliseconds;
  readonly clock: Clock;
  readonly log: FrameworkLog;
}

/** A `withdraw` that ran past its tool's timeout. */
class WithdrawTimeoutError extends Error {
  override name = "WithdrawTimeoutError";

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

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Logs a withdrawal that failed: the channel, the pause's execution, why. */
export function logWithdrawFailed(
  log: FrameworkLog,
  call: Pick<ChannelWithdrawalCall, "channel" | "pause">,
  error: unknown,
): void {
  const { pause } = call;
  const text = `channel ${call.channel}: withdraw() failed for a pause of ${pause.agent}: ${messageOf(error)}`;
  log.warn(WITHDRAW_FAILED, text, { executionId: pause.executionId, tenantId: pause.tenantId });
}

/** Tells the channel once; never throws. A channel without `withdraw` is not told. */
export async function withdrawFromChannel(call: ChannelWithdrawalCall): Promise<void> {
  const { sender, pause, resolution } = call;
  if (sender.withdraw === undefined) return;
  const timer = timeoutOn(call.clock, call.timeout, () => new WithdrawTimeoutError(call.timeout));
  try {
    const withdrawal = { pauseId: pause.pauseId, value: pause.ask, resolution };
    const work = runInFrame(withSignal(call.frame, timer.signal), async () => {
      await sender.withdraw?.(withdrawal);
    });
    await untilAborted(work, timer.signal);
  } catch (error) {
    logWithdrawFailed(call.log, call, error);
  } finally {
    timer.release();
  }
}
