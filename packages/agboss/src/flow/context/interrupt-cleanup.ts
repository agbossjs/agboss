import { AsyncLocalStorage } from "node:async_hooks";
import { ExecutionCancelledError } from "../../core/errors.js";
import { ExecutionStoppedError, isPause } from "../../app/lease-stopped.js";
import { isHandedOver } from "../../app/handed-over.js";
import { InterruptReason } from "../../app/interrupt-types.js";

/**
 * Structured-concurrency cleanup of a step (#1341b): what `executionContext.onInterrupted(cleanup)`
 * registers is kept by the step's frame (a tool call's own frame inside its agent's) and run only when
 * the step is interrupted — never when it ends normally —, awaited, one after another in LIFO order
 * (the last resource acquired is released first), each under the async context of its registration,
 * and each failure reported (`onInterruptCleanupError`) without stopping the rest or failing the
 * execution. The frame runs them before it closes, so the lease is released and compensations start
 * only after they are done.
 */

/** A cleanup of an interrupted step: told why. */
export type InterruptCleanup = (reason: InterruptReason) => void | Promise<void>;

/** What a frame keeps of the cleanups registered in it. */
export interface InterruptCleanups {
  /** Registers `cleanup`, bound to the async context of this call. */
  readonly add: (cleanup: InterruptCleanup) => void;
  /** Runs them, newest first, for `reason`; every failure goes to `report`. */
  readonly run: (
    reason: InterruptReason,
    report: (reason: InterruptReason, error: unknown) => Promise<void> | void,
    /** Aborted when the bound of the cleanups passed: the ones not started yet are not run. */
    stop?: AbortSignal,
  ) => Promise<void>;
}

/** A function run in the async context it was made in. */
type Bound = <TResult>(work: () => TResult) => TResult;

export function interruptCleanups(): InterruptCleanups {
  const kept: { readonly cleanup: InterruptCleanup; readonly bound: Bound }[] = [];
  return {
    add: (cleanup) => {
      kept.push({ cleanup, bound: AsyncLocalStorage.snapshot() });
    },
    run: async (reason, report, stop) => {
      // newest first, each one once: a cleanup that registers another meanwhile is not run again
      for (const { cleanup, bound } of kept.splice(0).reverse()) {
        if (stop?.aborted === true) return;
        try {
          await bound(() => cleanup(reason));
        } catch (error) {
          await Promise.resolve(report(reason, error)).catch((): undefined => undefined);
        }
      }
    },
  };
}

/** The reason a step was interrupted for, from what ended it; `undefined` for a failure or a normal end. */
export function interruptReasonOf(
  error: unknown,
  signal: AbortSignal,
): InterruptReason | undefined {
  const cause: unknown = error ?? (signal.aborted ? (signal.reason as unknown) : undefined);
  // a pause is a stop that parks (#1341c): its steps are told `Paused`, never `Stopped`
  if (isPause(cause)) return InterruptReason.Paused;
  if (cause instanceof ExecutionStoppedError) return InterruptReason.Stopped;
  if (cause instanceof ExecutionCancelledError) return InterruptReason.Cancelled;
  if (isHandedOver(cause)) return InterruptReason.HandedOver;
  const isTimeout = cause instanceof Error && cause.name === "TimeoutError";
  return signal.aborted && isTimeout ? InterruptReason.TimedOut : undefined;
}
