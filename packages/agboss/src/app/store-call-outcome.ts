import { StoreError } from "../core/error-families/store-errors.js";
import type { Clock } from "../infrastructure/clock.js";
import type { FrameworkLog } from "../infrastructure/logger.js";
import { isStoreOutcomeUnknown, StoreOutcomeSource } from "../infrastructure/store-call-timeout.js";
import { ExecutionLeaseLostError } from "./lease-lost.js";
import type { StoreCallLimit } from "./store-call-kind.js";

/** What a bounded call reports when it ends in a timeout or a store error (#928). */

/** Where a call given up at its bound is counted (`agboss.instance.store_calls.timed_out`). */
export interface StoreCallCounter {
  add(count: number, attributes: Record<string, string>): void;
}

/** What the bound reports to: the clock it runs on, and the log and counter once the instance has them. */
export interface StoreCallParts {
  readonly clock: Clock;
  readonly log?: FrameworkLog | undefined;
  /** Counts a timeout: `agboss.instance.store_calls.timed_out`. */
  readonly timedOut?: StoreCallCounter | undefined;
}

/** The facts of one call a bound reports. */
export interface CallFacts extends StoreCallLimit {
  readonly contract: string;
  readonly store: string;
  readonly operation: string;
}

/**
 * `value` as an `Error`: itself, or an `Error` with its text and itself as the cause. A value that
 * cannot be turned into text (a `toString` that throws) is still an error, never a throw: the call
 * that rejected with it must settle.
 */
export function errorOf(value: unknown): Error {
  if (value instanceof Error) return value;
  let text: string;
  try {
    text = String(value);
  } catch {
    text = "a value that cannot be read as text";
  }
  return new Error(text, { cause: value });
}

/** Runs a report (a log line, a counter): one that throws never changes how the call ends. */
function quietly(report: () => void): void {
  try {
    report();
  } catch {
    // the report is lost, the call's outcome is not
  }
}

/** Logs and counts a call given up on: `store.call-timeout`, `agboss.instance.store_calls.timed_out`. */
function reportTimeout(
  parts: StoreCallParts,
  facts: CallFacts,
  error: StoreError.CallTimeout,
): void {
  const how =
    error.source === StoreOutcomeSource.Framework
      ? `${facts.kind} call; its late answer is dropped`
      : `${facts.kind} call; the store's own timeout`;
  const { executionId, tenantId } = {
    executionId: facts.lease?.leaseExecutionId,
    tenantId: facts.lease?.tenantId,
  };
  const { source } = error;
  const { contract, operation, kind } = facts;
  quietly(() =>
    // Stryker disable next-line OptionalChaining: equivalent: with no log `parts.log.warn` throws a TypeError, which `quietly` swallows as the missing log does
    parts.log?.warn("store.call-timeout", `${error.message} (${how})`, { executionId, tenantId }),
  );
  // Stryker disable next-line OptionalChaining: equivalent: with no counter `parts.timedOut.add` throws a TypeError, which `quietly` swallows as the missing counter does
  quietly(() => parts.timedOut?.add(1, { contract, operation, source, kind }));
}

/** What the holder is told and the log shows when the bound fired. */
export function timedOut(parts: StoreCallParts, facts: CallFacts): StoreError.CallTimeout {
  const { store, operation } = facts;
  const timeout = facts.bound;
  const error = new StoreError.CallTimeout({
    store,
    operation,
    timeout,
    source: StoreOutcomeSource.Framework,
  });
  reportTimeout(parts, facts, error);
  return error;
}

/**
 * What a rejection of the store becomes: a hand-over when the call was leased and its outcome is
 * unknown. A store's own command timeout is counted and logged here, as the bound's own is.
 */
export async function failure(
  parts: StoreCallParts,
  facts: CallFacts,
  error: unknown,
): Promise<Error> {
  if (error instanceof StoreError.CallTimeout && error.source === StoreOutcomeSource.Command)
    reportTimeout(parts, facts, error);
  const { lease } = facts;
  if (lease === undefined || !isStoreOutcomeUnknown(error)) return errorOf(error);
  if (error.source !== StoreOutcomeSource.Framework)
    quietly(() =>
      // Stryker disable next-line OptionalChaining: equivalent: with no log `parts.log.warn` throws a TypeError, which `quietly` swallows as the missing log does
      parts.log?.warn(
        "store.outcome-unknown",
        `${error.message} (${facts.kind} call: the tree is handed over, the next holder reconciles it)`,
        { executionId: lease.leaseExecutionId, tenantId: lease.tenantId },
      ),
    );
  // an abandon that fails leaves the lease to expire in its store, which is what a hand-over does anyway
  try {
    await lease.abandon?.(error);
  } catch (abandonError) {
    quietly(() =>
      // Stryker disable next-line OptionalChaining: equivalent: with no log `parts.log.warn` throws a TypeError, which `quietly` swallows as the missing log does
      parts.log?.warn(
        "execution.lease-abandon-failed",
        `abandoning the lease failed (${abandonError instanceof Error ? abandonError.message : String(abandonError)}); it expires in its store`,
        { executionId: lease.leaseExecutionId, tenantId: lease.tenantId },
      ),
    );
  }
  return new ExecutionLeaseLostError({ rootExecutionId: lease.leaseExecutionId, cause: error });
}

/** The error of a call whose lease was lost while it hung: the lease's own reason. */
export const lostOf = (facts: CallFacts, reason: unknown): Error =>
  reason instanceof Error
    ? reason
    : new ExecutionLeaseLostError({ rootExecutionId: facts.lease?.leaseExecutionId ?? "" });
