import type { FrameServices } from "./frame.js";
import { interruptReasonOf, type InterruptCleanups } from "./interrupt-cleanup.js";

const noReport = (): undefined => undefined;

/**
 * What a frame does when its step ends or is interrupted (#1341b): the cleanups run before the
 * frame closes — so `executionContext` still reads inside them — and before the lease is released
 * or an undo starts: awaited, newest first, bounded by the step's `shutdownTimeout`.
 */
export function interruptedOf(
  interrupts: InterruptCleanups,
  services: FrameServices,
  signal: AbortSignal,
): (error?: unknown) => Promise<void> {
  return async (error) => {
    const reason = interruptReasonOf(error, signal);
    if (reason === undefined) return;
    const report = services.interruptCleanupFailed ?? noReport;
    const { interruptBound: bound } = services;
    if (bound === undefined) return interrupts.run(reason, report);
    // bounded: the cleanups and the bound's timer race; the one that lost is stopped
    const over = new AbortController();
    const ran = interrupts.run(reason, report, over.signal).then(() => "ran" as const);
    const timer = bound.sleep(bound.timeout, over.signal).then(() => "timed-out" as const);
    const first = await Promise.race([ran, timer]);
    if (first === "ran") {
      over.abort();
      return;
    }
    over.abort();
    await Promise.resolve(
      report(reason, new Error("the onInterrupted cleanups did not finish within shutdownTimeout")),
    ).catch(noReport);
  };
}

/** A tool call's services, told of an `onInterrupted` cleanup failing as its step is, and bound as it is (#1341b). */
export const withReport = (parent: FrameServices, own: FrameServices): FrameServices => ({
  ...own,
  ...(own.interruptCleanupFailed === undefined && parent.interruptCleanupFailed !== undefined
    ? { interruptCleanupFailed: parent.interruptCleanupFailed }
    : {}),
  // its cleanups are bounded like the step's own (`shutdownTimeout`)
  ...(own.interruptBound === undefined && parent.interruptBound !== undefined
    ? { interruptBound: parent.interruptBound }
    : {}),
});
