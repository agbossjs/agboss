import type { Clock } from "../infrastructure/clock.js";
import type { FrameworkLog } from "../infrastructure/logger.js";
import {
  StoreCallTimeoutError,
  StoreOutcomeSource,
  StoreOutcomeUnknownError,
} from "../infrastructure/store-call-timeout.js";
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

/** Logs and counts a call given up on: `store.call-timeout`, `agboss.instance.store_calls.timed_out`. */
function reportTimeout(
  parts: StoreCallParts,
  facts: CallFacts,
  error: StoreCallTimeoutError,
): void {
  const how =
    error.source === StoreOutcomeSource.Framework
      ? `${facts.kind} call; its late answer is dropped`
      : `${facts.kind} call; the store's own timeout`;
  const { executionId, tenantId } = {
    executionId: facts.lease?.leaseExecutionId,
    tenantId: facts.lease?.tenantId,
  };
  parts.log?.warn("store.call-timeout", `${error.message} (${how})`, { executionId, tenantId });
  const { source } = error;
  const { contract, operation, kind } = facts;
  parts.timedOut?.add(1, { contract, operation, source, kind });
}

/** What the holder is told and the log shows when the bound fired. */
export function timedOut(parts: StoreCallParts, facts: CallFacts): StoreCallTimeoutError {
  const { store, operation } = facts;
  const timeout = facts.bound;
  const error = new StoreCallTimeoutError({
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
  if (error instanceof StoreCallTimeoutError && error.source === StoreOutcomeSource.Command)
    reportTimeout(parts, facts, error);
  const { lease } = facts;
  if (lease === undefined || !(error instanceof StoreOutcomeUnknownError))
    return error instanceof Error ? error : new Error(String(error), { cause: error });
  if (error.source !== StoreOutcomeSource.Framework)
    parts.log?.warn(
      "store.outcome-unknown",
      `${error.message} (${facts.kind} call: the tree is handed over, the next holder reconciles it)`,
      { executionId: lease.leaseExecutionId, tenantId: lease.tenantId },
    );
  await lease.abandon?.(error);
  return new ExecutionLeaseLostError({ rootExecutionId: lease.leaseExecutionId, cause: error });
}

/** The error of a call whose lease was lost while it hung: the lease's own reason. */
export const lostOf = (facts: CallFacts, reason: unknown): Error =>
  reason instanceof Error
    ? reason
    : new ExecutionLeaseLostError({ rootExecutionId: facts.lease?.leaseExecutionId ?? "" });
